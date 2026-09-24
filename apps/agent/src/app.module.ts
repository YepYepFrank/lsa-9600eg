import { Module } from '@nestjs/common'
import { configProvider } from './config.js'
import { BusService } from './bus/bus.service.js'
import { StatusController } from './status/status.controller.js'
import { SelfService } from './self/self.service.js'

@Module({
  controllers: [StatusController],
  providers: [configProvider, BusService, SelfService],
})
export class AppModule {}
