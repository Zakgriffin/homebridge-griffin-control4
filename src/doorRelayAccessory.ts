import { PlatformAccessory } from "homebridge";
import { C4Item } from "./control4";
import { platform } from "./platform";

const POLL_INTERVAL = 5000;

export function beginDoorRelayAccessory(accessory: PlatformAccessory, item: C4Item) {
  const { control4, api, log } = platform;
  const { Characteristic, Service } = api.hap;
  const { SECURED, UNSECURED } = Characteristic.LockCurrentState;

  const service = accessory.getService(Service.LockMechanism)
    ?? accessory.addService(Service.LockMechanism);

  let currentState: number = SECURED;
  let targetState: number = SECURED;

  service
    .getCharacteristic(Characteristic.LockCurrentState)
    .onGet(() => currentState);

  service
    .getCharacteristic(Characteristic.LockTargetState)
    .onGet(() => targetState)
    .onSet(async (value) => {
      targetState = value as number;
      await control4.sendCommand(item.id, value === UNSECURED ? "OPEN" : "CLOSE");
      // Relay is momentary — pulse open then auto-return to secured
      if (value === UNSECURED) {
        setTimeout(() => {
          targetState = SECURED;
          service.updateCharacteristic(Characteristic.LockTargetState, SECURED);
        }, 3000);
      }
    });

  async function poll() {
    try {
      const state = await control4.getVariable(item.id, "RelayState");
      currentState = (state === "1" || state === "true") ? UNSECURED : SECURED;
      service.updateCharacteristic(Characteristic.LockCurrentState, currentState);
    } catch (err) {
      log.error(`[${item.name}] poll error:`, (err as Error).message);
    }
    setTimeout(poll, POLL_INTERVAL);
  }

  poll();
}
