import { PrismaClient } from '@prisma/client'
import { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify'
import { Logger } from '../libs/logger'
import { ConfirmRoute } from './confirm'
import { FacebookRoute } from './facebook'
import { LandingRoute } from './landing'
import { OAuth2Route } from './oauth2'

export interface Route {
  path: string
  method: HTTPMethods
  handle(req: FastifyRequest, res: FastifyReply): MaybePromise<any>
}

export class RouteManager {
  private routes: Route[]
  private logger = Logger.label('route')

  constructor(private fastify: FastifyInstance, prisma: PrismaClient) {
    this.routes = [
      new LandingRoute('/', 'GET'),
      new OAuth2Route('/oauth2', 'POST', prisma),
      new FacebookRoute('/webhook/facebook', 'POST', prisma),
      new ConfirmRoute('/api/confirm/:uuid', 'GET', prisma),
    ]
  }

  private async handleRoute(route: Route, req: FastifyRequest, res: FastifyReply) {
    try {
      this.logger.info('Will handle route at "%s"', route.path)
      const result = await route.handle(req, res)
      this.logger.info('Did handle route at "%s"', route.path)

      if (typeof result === 'string') {
        res.type('text/html')
      }

      return result
    } catch (error) {
      this.logger.error('Error while handling route at "%s": %s', route.path, error)
      throw error
    }
  }

  registerRoutes() {
    this.routes.forEach((route) => {
      this.fastify.route({
        url: route.path,
        method: route.method,
        handler: (req, res) => this.handleRoute(route, req, res),
      })

      this.logger.debug('Succesfully registered route at "%s"', route.path)
    })
  }
}
