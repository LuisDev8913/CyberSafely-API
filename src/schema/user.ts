import { ArgBuilder, InputShapeFromFields } from '@pothos/core'
import Prisma from '@prisma/client'
import { format } from 'date-fns'
import { hasRoleInSchoolId, hasRoleToUserId, isParentToUserId, isSameUserId } from '../helpers/auth'
import { getStorageExactBlobName, storageSaveUpload } from '../libs/storage'
import { prisma } from '../prisma'
import { logActivity } from '../utils/activity'
import { DefaultSchemaType, builder } from './builder'
import { createFilterInput } from './filter'
import { Image } from './image'
import { createOrderInput } from './order'
import { createPage, createPageArgs, createPageObjectRef } from './page'
import { Platform, PlatformEnum } from './post'
import { Twitter } from './twitter'
import { UserRole, UserRoleStatusEnum, UserRoleTypeEnum } from './user-role'

export const UsersFromEnum = builder.enumType('UsersFromEnum', {
  values: ['SCHOOL', 'PARENT', 'CHILD'] as const,
})

export const User = builder.loadableObjectRef<Prisma.User, string>('User', {
  load: async (keys) => {
    const users = await prisma.user.findMany({ where: { id: { in: keys } } })
    return keys.map((key) => users.find((user) => user.id === key)!)
  },
})

export const UserPage = createPageObjectRef(User)

export const UserOrder = createOrderInput(
  User,
  (t) => ({
    createdAt: t.order(),
    name: t.order(),
    email: t.order(),
    roles: t.order(),
  }),
  ({ createdAt, name, email, roles }) => {
    const orderBy: Prisma.Prisma.UserOrderByWithRelationInput[] = []

    if (createdAt) orderBy.push({ createdAt })
    if (name) orderBy.push({ name })
    if (email) orderBy.push({ email })
    if (roles) orderBy.push({ roles: { _count: roles } })

    return orderBy
  }
)

export const UserFilter = createFilterInput(
  User,
  (t) => ({
    from: t.field({ type: UsersFromEnum, required: false }),
    fromId: t.id({ required: false }),
    search: t.string({ required: false }),
    roles: t.field({ type: [UserRoleTypeEnum], required: false }),
  }),
  ({ from, fromId, search, roles }) => {
    const where: Prisma.Prisma.UserWhereInput = {}

    if (roles) {
      where.roles = { some: { type: { in: roles } } }
    }

    if (from && fromId) {
      switch (from) {
        case 'SCHOOL':
          where.roles = {
            some: {
              type: roles ? { in: roles } : undefined,
              schoolRole: { schoolId: fromId },
            },
          }
          break

        case 'PARENT':
          where.parentRoles = { some: { userRole: { userId: fromId } } }
          break

        case 'CHILD':
          where.roles = { some: { parentRole: { childUserId: fromId } } }
          break
      }
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ]
    }

    return where
  }
)

function createRolesArgs(arg: ArgBuilder<DefaultSchemaType>) {
  return {
    status: arg({ type: UserRoleStatusEnum, required: false }),
  }
}

type RolesArgs = InputShapeFromFields<ReturnType<typeof createRolesArgs>>

User.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    createdAt: t.expose('createdAt', { type: 'DateTime' }),
    email: t.exposeString('email'),
    name: t.exposeString('name'),
    parentalApproval: t.exposeBoolean('parentalApproval', { nullable: true }),
    platforms: t.field({
      type: [PlatformEnum],
      resolve: (post) => {
        const platforms: Platform[] = []

        if (post.twitterId) {
          platforms.push('TWITTER')
        }

        return platforms
      },
    }),
    avatar: t.field({
      type: Image,
      nullable: true,
      resolve: (user) => user.avatarId,
    }),
    roles: t.loadableList({
      type: UserRole,
      args: {
        ...createRolesArgs(t.arg),
      },
      resolve: (user, args) => [user.id, JSON.stringify(args)].join(';'),
      load: async (keys: string[]) => {
        const results = keys.map((key) => {
          const [id, args] = key.split(';')
          return [id, args as RolesArgs] as const
        })
        const userRoles = await prisma.userRole.findMany({
          where: { userId: { in: results.map(([id]) => id) } },
          include: {
            schoolRole: { include: { school: true } },
            parentRole: { include: { childUser: true } },
          },
        })
        return results.map(([userId, { status }]) =>
          userRoles.filter((userRole) => userRole.userId === userId && (!status || userRole.status === status))
        )
      },
    }),
    notificationCount: t.int({
      resolve: async (user) => {
        return prisma.notification.count({
          where: { unread: true, userId: user.id },
        })
      },
    }),
    twitter: t.field({
      type: Twitter,
      nullable: true,
      resolve: (user) => {
        if (user.twitterId) {
          return prisma.twitter.findUnique({
            where: { id: user.twitterId },
          })
        }
      },
    }),
  }),
})

builder.queryFields((t) => ({
  users: t.field({
    authScopes: (obj, { filter }, { user }) => {
      if (filter?.from && filter?.fromId) {
        switch (filter.from) {
          case 'SCHOOL':
            if (hasRoleInSchoolId(filter.fromId, user)) {
              return true
            }
            break

          case 'PARENT':
            if (isSameUserId(filter.fromId, user)) {
              return true
            }
            break

          case 'CHILD':
            if (isSameUserId(filter.fromId, user) || hasRoleToUserId(filter.fromId, user, ['ADMIN', 'COACH'])) {
              return true
            }
            break
        }
      }

      return { staff: true }
    },
    type: UserPage,
    args: {
      ...createPageArgs(t.arg),
      order: t.arg({ type: UserOrder, required: false }),
      filter: t.arg({ type: UserFilter, required: false }),
    },
    resolve: (obj, { page, order, filter }) => {
      const where = UserFilter.toFilter(filter)
      const orderBy = UserOrder.toOrder(order)

      return createPage(page, (args) =>
        prisma.$transaction([prisma.user.findMany({ ...args, where, orderBy }), prisma.user.count({ where })])
      )
    },
  }),
  user: t.field({
    authScopes: (obj, { id }, { user }) => {
      if (isSameUserId(id, user) || hasRoleToUserId(id, user) || isParentToUserId(id, user)) {
        return true
      }

      return { staff: true }
    },
    type: User,
    args: {
      id: t.arg.id(),
    },
    resolve: (obj, { id }) => {
      return prisma.user.findUniqueOrThrow({ where: { id } })
    },
  }),
}))

builder.mutationFields((t) => ({
  updateUser: t.fieldWithInput({
    authScopes: (obj, { id }, { user }) => {
      if (isSameUserId(id, user)) {
        return true
      }

      return { staff: true }
    },
    type: User,
    args: {
      id: t.arg.id(),
    },
    input: {
      name: t.input.string({ required: false }),
      newEmail: t.input.string({ required: false }),
    },
    resolve: (obj, { id, input }) => {
      return prisma.user.update({
        where: { id },
        data: {
          name: input.name ?? undefined,
          newEmail: input.newEmail ?? undefined,
        },
      })
    },
  }),
  updateUserParentalApproval: t.boolean({
    authScopes: (obj, { id }, { user }) => {
      return isParentToUserId(id, user)
    },
    args: {
      id: t.arg.id(),
      approve: t.arg.boolean(),
      signatureUploadId: t.arg.id({ required: false }),
    },
    resolve: async (obj, { id, approve, signatureUploadId }, { req, user }) => {
      if (approve) {
        if (!signatureUploadId) {
          throw new Error('Signature required for approving child')
        }

        const upload = await prisma.upload.findUniqueOrThrow({
          where: { id: signatureUploadId },
        })

        const blobName = getStorageExactBlobName(
          'users',
          user!.id,
          'signatures',
          'signature-' + format(new Date(), 'yyyy-MM-dd-HH-mm')
        )
        const { url } = await storageSaveUpload(upload.blobName, blobName)

        const { id: signatureId } = await prisma.$transaction(async (prisma) => {
          await prisma.upload.delete({
            where: { id: upload.id },
          })
          return await prisma.image.create({
            data: { url },
          })
        })

        await prisma.parentConsent.create({
          data: {
            signatureId,
            version: 'v1', // This is a filler for now
            childUserId: id,
            parentUserId: user!.id,
            ip: req.ip ?? req.headers['x-forwarded-for'] ?? '127.0.0.1',
          },
        })
      }

      await prisma.user.update({
        where: { id },
        data: { parentalApproval: approve },
      })

      logActivity('PARENTAL_APPROVAL', id)

      return true
    },
  }),
}))