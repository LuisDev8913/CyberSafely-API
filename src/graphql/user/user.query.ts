import { Prisma } from '@prisma/client'
import gql from 'graphql-tag'
import { createGraphQLModule } from '..'
import { withAuth } from '../../helpers/auth'
import { paginated } from '../../helpers/parse'
import { UserInclude } from './user.include'
import { parseUserOrder } from './user.utils'

export default createGraphQLModule({
  typeDefs: gql`
    extend type Query {
      users(page: Page, order: UserOrder): PaginatedUser!
      user(id: ID!): User!
    }
  `,
  resolvers: {
    Query: {
      users: withAuth('staff', (obj, { page, order }, { prisma }, info) => {
        const where: Prisma.UserWhereInput = {}

        return paginated(page, (args) =>
          prisma.$transaction([
            prisma.user.findMany({
              ...args,
              where,
              include: UserInclude,
              orderBy: parseUserOrder(order),
            }),
            prisma.user.count({ where }),
          ])
        )
      }),
      user: withAuth('staff', (obj, { id }, { prisma }, info) => {
        return prisma.user.findUniqueOrThrow({
          where: { id },
          include: UserInclude,
        })
      }),
    },
  },
})
