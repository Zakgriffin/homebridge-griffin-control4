import { PlatformAccessory, HAP } from "homebridge";
import { C4Item } from "./control4";
import { platform } from "./platform";

export function beginTvAccessory(accessory: PlatformAccessory, item: C4Item): void {
  const { control4, api, log, config } = platform;
  const { Characteristic, Service } = api.hap;

  // Discover input sources from items list — all video sources in the rack (cable, AppleTV/dvd, disc changer)
  // MEDIA WALL INFO is only populated when the room is active, so we can't rely on it statically
  const VIDEO_SOURCE_PROXIES = new Set(["cable", "dvd", "discchanger"]);
  type Source = { id: number; name: string };
  const sources: Source[] = Array.from(platform.itemsById.values())
    .filter(i => VIDEO_SOURCE_PROXIES.has(i.proxy) && i.proxyOrder === 1)
    .map(i => ({ id: i.id, name: i.name }));

  log.info(`[${item.name}] inputs: ${sources.map(s => `${s.name}(${s.id})`).join(", ") || "none"}`);

  // Television service
  const tvService = accessory.getService(Service.Television)
    ?? accessory.addService(Service.Television, item.name, `room-${item.id}`);
  tvService.setCharacteristic(Characteristic.ConfiguredName, item.name);
  tvService.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

  let isOn = false;
  let isMuted = false;
  let currentSourceId = 0;
  let lastSourceId = sources[0]?.id ?? 0;

  tvService
    .getCharacteristic(Characteristic.Active)
    .onGet(() => isOn ? 1 : 0)
    .onSet(async (value) => {
      if (value === 0) {
        await control4.sendCommand(item.id, "ROOM_OFF");
      } else {
        const sourceId = currentSourceId || lastSourceId;
        if (sourceId) await control4.sendCommand(item.id, "SELECT_VIDEO_DEVICE", { deviceid: sourceId, deselect: 1 });
      }
    });

  // Input source services — one per discovered source
  const inputEntries = sources.map((source, index) => {
    const identifier = index + 1;
    const inputService = accessory.getServiceById(Service.InputSource, `input-${source.id}`)
      ?? accessory.addService(Service.InputSource, source.name, `input-${source.id}`);
    inputService.setCharacteristic(Characteristic.Identifier, identifier);
    inputService.setCharacteristic(Characteristic.ConfiguredName, source.name);
    inputService.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);
    inputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI);
    inputService.setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
    tvService.addLinkedService(inputService);
    return { service: inputService, sourceId: source.id, identifier };
  });

  tvService
    .getCharacteristic(Characteristic.ActiveIdentifier)
    .onGet(() => inputEntries.find(e => e.sourceId === currentSourceId)?.identifier ?? (inputEntries[0]?.identifier ?? 1))
    .onSet(async (value) => {
      const entry = inputEntries.find(e => e.identifier === value);
      if (entry) {
        await control4.sendCommand(item.id, "SELECT_VIDEO_DEVICE", { deviceid: entry.sourceId, deselect: 1 });
        lastSourceId = entry.sourceId;
      }
    });

  tvService
    .getCharacteristic(Characteristic.RemoteKey)
    .setProps({
      validValues: [
        Characteristic.RemoteKey.REWIND,
        Characteristic.RemoteKey.FAST_FORWARD,
        Characteristic.RemoteKey.NEXT_TRACK,
        Characteristic.RemoteKey.PREVIOUS_TRACK,
        Characteristic.RemoteKey.ARROW_UP,
        Characteristic.RemoteKey.ARROW_DOWN,
        Characteristic.RemoteKey.ARROW_LEFT,
        Characteristic.RemoteKey.ARROW_RIGHT,
        Characteristic.RemoteKey.SELECT,
        Characteristic.RemoteKey.BACK,
        Characteristic.RemoteKey.EXIT,
        Characteristic.RemoteKey.PLAY_PAUSE,
      ],
    })
    .onSet(async (value) => {
      const sourceId = currentSourceId || lastSourceId;
      if (!sourceId) return;
      const sourceProxy = platform.itemsById.get(sourceId)?.proxy;
      const cmd = remoteKeyToC4Command(value as number, sourceProxy, Characteristic);
      if (cmd) {
        log.info(`[${item.name}] RemoteKey ${value} → ${cmd} on device ${sourceId}`);
        await control4.sendCommand(sourceId, cmd);
      }
    });

  // Speaker service — relative volume (roomdevice only has pulse up/down, no absolute set)
  const speakerService = accessory.getService(Service.TelevisionSpeaker)
    ?? accessory.addService(Service.TelevisionSpeaker);
  speakerService.setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.RELATIVE);
  speakerService
    .getCharacteristic(Characteristic.VolumeSelector)
    .onSet(async (value) => {
      await control4.sendCommand(item.id, value === Characteristic.VolumeSelector.INCREMENT ? "PULSE_VOL_UP" : "PULSE_VOL_DOWN");
    });
  speakerService
    .getCharacteristic(Characteristic.Mute)
    .onGet(() => isMuted)
    .onSet(async (value) => {
      await control4.sendCommand(item.id, value ? "MUTE_ON" : "MUTE_OFF");
    });
  tvService.addLinkedService(speakerService);

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
      currentSourceId = parseInt(selectedDevice) || 0;
      if (currentSourceId) lastSourceId = currentSourceId;

      const activeIdentifier = inputEntries.find(e => e.sourceId === currentSourceId)?.identifier ?? (inputEntries[0]?.identifier ?? 1);
      tvService.updateCharacteristic(Characteristic.Active, isOn ? 1 : 0);
      tvService.updateCharacteristic(Characteristic.ActiveIdentifier, activeIdentifier);
      speakerService.updateCharacteristic(Characteristic.Mute, isMuted);
    } catch (err) {
      log.error(`[${item.name}] poll error:`, (err as Error).message);
    }
    setTimeout(poll, INTERVAL);
  }

  poll();
}

function remoteKeyToC4Command(key: number, proxy: string | undefined, Characteristic: HAP["Characteristic"]): string | null {
  const { RemoteKey } = Characteristic;
  const isCable = proxy === "cable";
  switch (key) {
    case RemoteKey.ARROW_UP:        return "UP";
    case RemoteKey.ARROW_DOWN:      return "DOWN";
    case RemoteKey.ARROW_LEFT:      return "LEFT";
    case RemoteKey.ARROW_RIGHT:     return "RIGHT";
    case RemoteKey.SELECT:          return "ENTER";
    case RemoteKey.BACK:            return "MENU";
    case RemoteKey.EXIT:            return "MENU";
    case RemoteKey.PLAY_PAUSE:      return "PAUSE";
    case RemoteKey.FAST_FORWARD:    return isCable ? "CHANNEL_UP" : "SCAN_FWD";
    case RemoteKey.REWIND:          return isCable ? "CHANNEL_DOWN" : "SCAN_REV";
    case RemoteKey.NEXT_TRACK:      return "SKIP_FWD";
    case RemoteKey.PREVIOUS_TRACK:  return "SKIP_REV";
    case RemoteKey.INFORMATION:     return null;
    default:                        return null;
  }
}
