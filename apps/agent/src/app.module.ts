import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { configProvider } from './config.js'
import { AlarmsController } from './alarms/alarms.controller.js'
import { AlarmsService } from './alarms/alarms.service.js'
import { ApplyController } from './apply/apply.controller.js'
import { ApplyService } from './apply/apply.service.js'
import { AttrsService } from './attrs/attrs.service.js'
import { AuditService } from './audit/audit.service.js'
import { AuthController } from './auth/auth.controller.js'
import { AuthService } from './auth/auth.service.js'
import { AuthGuard } from './auth/guard.js'
import { BusService } from './bus/bus.service.js'
import { ComponentsController } from './components/components.controller.js'
import { ComponentsService } from './components/components.service.js'
import { CatalogController } from './catalog/catalog.controller.js'
import { ConfigController } from './config/config.controller.js'
import { DeriveService } from './derive/derive.service.js'
import { QualityService } from './quality/quality.service.js'
import { SelfService } from './self/self.service.js'
import { SouthService } from './south/south.service.js'
import { StatusController } from './status/status.controller.js'
import { LocalTbService } from './tb/local-tb.service.js'
import { UplinkService } from './uplink/uplink.service.js'
import { VideoClient, VideoController } from './video/video.controller.js'
import { EvidenceController } from './evidence/evidence.controller.js'
import { EvidenceService } from './evidence/evidence.service.js'
import { HistoryController } from './history/history.controller.js'
import { CapsService } from './caps/caps.service.js'
import { CapsActualService } from './caps/caps-actual.service.js'
import { CapsController } from './caps/caps.controller.js'
import { GatewayConfigService } from './gateway/gateway-config.service.js'

@Module({
  controllers: [AuthController, StatusController, ComponentsController, ConfigController, CatalogController, AlarmsController, ApplyController, VideoController, EvidenceController, HistoryController, CapsController],
  providers: [
    configProvider,
    AuditService,
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
    BusService,
    CapsService,
    AttrsService,
    QualityService,
    DeriveService,
    SouthService,
    SelfService,
    ComponentsService,
    UplinkService,
    LocalTbService,
    AlarmsService,
    ApplyService,
    VideoClient,
    EvidenceService,
    CapsActualService,
    GatewayConfigService,
  ],
})
export class AppModule {}
