import { PlatformAccessory } from "homebridge";
import { C4Item } from "./control4";
import { platform } from "./platform";

export function beginAudioRoomAccessory(accessory: PlatformAccessory, item: C4Item): void {
  const { control4, api, log, config } = platform;
  const { Characteristic, Service } = api.hap;

  const speakerService = accessory.getService(Service.SmartSpeaker)
    ?? accessory.addService(Service.SmartSpeaker, item.name, `room-${item.id}`);
  speakerService.setCharacteristic(Characteristic.ConfiguredName, item.name);
  speakerService.setPrimaryService(true);

  let isOn = false;
  let isMuted = false;
  let lastSourceId = 0;

  speakerService
    .getCharacteristic(Characteristic.CurrentMediaState)
    .onGet(() => isOn
      ? Characteristic.CurrentMediaState.PLAY
      : Characteristic.CurrentMediaState.STOP
    );

  speakerService
    .getCharacteristic(Characteristic.TargetMediaState)
    .onGet(() => isOn
      ? Characteristic.TargetMediaState.PLAY
      : Characteristic.TargetMediaState.STOP
    )
    .onSet(async (value) => {
      if (value === Characteristic.TargetMediaState.STOP) {
        await control4.sendCommand(item.id, "ROOM_OFF");
      } else if (lastSourceId) {
        await control4.sendCommand(item.id, "SELECT_AUDIO_DEVICE", { deviceid: lastSourceId, deselect: 1 });
      }
    });

  const tvSpeakerService = accessory.getService(Service.TelevisionSpeaker)
    ?? accessory.addService(Service.TelevisionSpeaker);
  tvSpeakerService.setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.RELATIVE);
  tvSpeakerService
    .getCharacteristic(Characteristic.VolumeSelector)
    .onSet(async (value) => {
      await control4.sendCommand(item.id,
        value === Characteristic.VolumeSelector.INCREMENT ? "PULSE_VOL_UP" : "PULSE_VOL_DOWN");
    });
  tvSpeakerService
    .getCharacteristic(Characteristic.Mute)
    .onGet(() => isMuted)
    .onSet(async (value) => {
      await control4.sendCommand(item.id, value ? "MUTE_ON" : "MUTE_OFF");
    });
  speakerService.addLinkedService(tvSpeakerService);

  const INTERVAL = ((config.telemetryIntervalSeconds as number | undefined) ?? 60) * 1000;

  async function poll() {
    try {
      const [powerState, muted, selectedDevice] = await Promise.all([
        control4.getVariable(item.id, "POWER_STATE"),
        control4.getVariable(item.id, "IS_MUTED"),
        control4.getVariable(item.id, "CURRENT_SELECTED_DEVICE"),
      ]);

      isOn = powerState === "1" || powerState === "true";
      isMuted = muted === "1" || muted === "true";
      const sourceId = parseInt(selectedDevice) || 0;
      if (sourceId) lastSourceId = sourceId;

      speakerService.updateCharacteristic(Characteristic.CurrentMediaState,
        isOn ? Characteristic.CurrentMediaState.PLAY : Characteristic.CurrentMediaState.STOP);
      speakerService.updateCharacteristic(Characteristic.TargetMediaState,
        isOn ? Characteristic.TargetMediaState.PLAY : Characteristic.TargetMediaState.STOP);
      tvSpeakerService.updateCharacteristic(Characteristic.Mute, isMuted);
    } catch (err) {
      log.error(`[${item.name}] poll error:`, (err as Error).message);
    }
    setTimeout(poll, INTERVAL);
  }

  poll();
}
