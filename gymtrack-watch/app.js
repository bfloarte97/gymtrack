import './shared/device-polyfill'
import { MessageBuilder } from './shared/message'

// Igual que el ejemplo oficial fetch-api (API 1.0): abre el canal reloj ⇄ móvil
App({
  globalData: {
    messageBuilder: null
  },
  onCreate() {
    const appId = hmApp.packageInfo().appId
    this.globalData.messageBuilder = new MessageBuilder({ appId })
    this.globalData.messageBuilder.connect()
  },
  onDestroy() {
    this.globalData.messageBuilder && this.globalData.messageBuilder.disConnect()
  }
})
