import { PlatformAccessory } from "homebridge";
import { C4Item } from "./control4";
import { platform } from "./platform";

const POLL_INTERVAL = 2000;

export function beginDoorbellAccessory(accessory: PlatformAccessory, item: C4Item) {
  const { control4, api, log } = platform;
  const { Characteristic, Service } = api.hap;

  const service = accessory.getService(Service.Doorbell) ?? accessory.addService(Service.Doorbell);

  service
    .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
    .setProps({ validValues: [Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS] });

  let lastState = "";

  async function poll() {
    try {
      const state = await control4.getVariable(item.id, "CONTACT_STATE");
      if (state === "1" && lastState !== "1") {
        log.info(`Doorbell pressed: ${item.name}`);
        service.updateCharacteristic(
          Characteristic.ProgrammableSwitchEvent,
          Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
        );
      }
      lastState = state;
    } catch (err) {
      log.error(`[${item.name}] poll error:`, (err as Error).message);
    }
    setTimeout(poll, POLL_INTERVAL);
  }

  poll();
}
