import { randAlphaNumeric } from '@ngneat/falso'
import { Prisma, PrismaClient } from '@prisma/client'
import { FastifyReply, FastifyRequest, HTTPMethods } from 'fastify'
import { z } from 'zod'
import { Config } from '../config'
import { Route } from './index'

const schema = z.object({
  uuid: z.string(),
})

export class ConfirmRoute implements Route {
  constructor(public path: string, public method: HTTPMethods, private prisma: PrismaClient) {}

  async handle(req: FastifyRequest, res: FastifyReply) {
    const params = schema.parse(req.params)

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { uuid: params.uuid },
    })

    const data: Prisma.UserUpdateInput = {
      emailConfirmed: true,
    }

    if (!user.password) {
      data.passwordToken = randAlphaNumeric({ length: 16 }).join('')
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data,
    })

    let redirect: string

    if (!user.password) {
      redirect = Config.composeUrl('webUrl', '/auth/activate/:token', { token: data.passwordToken! })
    } else {
      redirect = Config.composeUrl('webUrl', '/auth/login')
    }

    res.redirect(redirect)
  }
}