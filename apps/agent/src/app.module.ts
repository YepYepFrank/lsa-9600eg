import { Module } from '@nestjs/common'
import { configProvider } from './config.js'
import { AttrsService } from './attrs/attrs.service.js'
import { BusService } from './bus/bus.service.js'
import { DeriveService } from './derive/derive.service.js'
import { QualityService } from './quality/quality.service.js'
import { SelfService } from './self/self.service.js'
import { SouthService } from './south/south.service.js'
import { StatusController } from './status/status.controller.js'

@Module({
  controllers: [StatusController],
  providers: [configProvider, BusService, AttrsService, QualityService, DeriveService, SouthService, SelfService],
})
export class AppModule {}
