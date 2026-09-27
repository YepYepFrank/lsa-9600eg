import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { configProvider } from './config.js'
import { AttrsService } from './attrs/attrs.service.js'
import { AuditService } from './audit/audit.service.js'
import { AuthController } from './auth/auth.controller.js'
import { AuthService } from './auth/auth.service.js'
import { AuthGuard } from './auth/guard.js'
import { BusService } from './bus/bus.service.js'
import { ComponentsController } from './components/components.controller.js'
import { ComponentsService } from './components/components.service.js'
import { EdgeDbService } from './components/edge-db.service.js'
import { CatalogController } from './catalog/catalog.controller.js'
import { ConfigController } from './config/config.controller.js'
import { DeriveService } from './derive/derive.service.js'
import { QualityService } from './quality/quality.service.js'
import { SelfService } from './self/self.service.js'
import { SouthService } from './south/south.service.js'
import { StatusController } from './status/status.controller.js'

@Module({
  controllers: [AuthController, StatusController, ComponentsController, ConfigController, CatalogController],
  providers: [
    configProvider,
    AuditService,
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
    BusService,
    AttrsService,
    QualityService,
    DeriveService,
    SouthService,
    SelfService,
    ComponentsService,
    EdgeDbService,
  ],
})
export class AppModule {}
