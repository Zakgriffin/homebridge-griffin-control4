import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { Control4, C4Item } from "./control4";
import { beginThermostatAccessory } from "./thermostatAccessory";
import { beginTvAccessory } from "./tvAccessory";
import { beginAudioRoomAccessory } from "./audioRoomAccessory";
// import { beginDoorbellAccessory } from "./doorbellAccessory";
// import { beginDoorRelayAccessory } from "./doorRelayAccessory";

export let platform: Control4Platform;

export class Control4Platform implements DynamicPlatformPlugin {
  public control4!: Control4;
  public readonly accessories: PlatformAccessory[] = [];
  public itemsById = new Map<number, C4Item>();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    platform = this;
    this.api.on("didFinishLaunching", () => this.discoverDevices());
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    const { controllerIP, username, password } = this.config;
    if (!controllerIP || !username || !password) {
      this.log.error("Missing controllerIP, username, or password in config");
      return;
    }

    this.control4 = new Control4(controllerIP, username, password);

    try {
      await this.control4.initialize();
    } catch (err) {
      this.log.error("Failed to authenticate with Control4:", (err as Error).message);
      return;
    }

    this.log.info("Connected to Control4");

    let items: C4Item[];
    try {
      items = await this.control4.getItems();
    } catch (err) {
      this.log.error("Failed to fetch items:", (err as Error).message);
      return;
    }

    this.itemsById = new Map(items.map(i => [i.id, i]));

    // proxyOrder === 1 identifies logical proxy binding devices vs. physical protocol drivers
    const proxyItems = items.filter((i) => i.proxyOrder === 1);

    // Rooms with a tv proxy have a physical display — roomdevice for those rooms drives the full AV experience
    const videoRoomNames = new Set(
      proxyItems.filter(i => i.proxy === "tv").map(i => i.roomName).filter(Boolean),
    );
    this.log.info(`Video rooms detected: ${[...videoRoomNames].join(", ")}`);

    // ShairBridge items have no proxyOrder so must be searched from the full items list.
    // Filter by driver name to avoid picking up global services (Add Music, TuneIn, etc.) in Equipment Room.
    const audioRoomNames = new Set(
      items.filter(i => i.proxy === "media_service" && i.name === "ShairBridge" && i.roomName).map(i => i.roomName),
    );

    const { Categories } = this.api.hap;

    for (const item of proxyItems) {
      if (item.proxy === "thermostatV2") {
        this.log.info(`Found thermostat: ${item.name} (ID ${item.id})`);
        beginThermostatAccessory(this.getAccessory(item.name), item);
      } else if (item.proxy === "roomdevice" && videoRoomNames.has(item.roomName)) {
        this.log.info(`Found TV room: ${item.name} (ID ${item.id})`);
        // TV accessories must be external (not bridged) for HomeKit remote to work
        const tvAcc = new this.api.platformAccessory(item.name, this.api.hap.uuid.generate(item.name), Categories.TELEVISION);
        this.api.publishExternalAccessories(PLUGIN_NAME, [tvAcc]);
        this.log.info(`[${item.name}] Add in Home app → + → More options. Setup code is the same as the bridge — regroup digits as XXXX-XXXX (4+4)`);
        beginTvAccessory(tvAcc, item);
      }
      // else if (item.proxy === "roomdevice" && audioRoomNames.has(item.roomName) && !videoRoomNames.has(item.roomName)) {
      //   this.log.info(`Found audio room: ${item.name} (ID ${item.id})`);
      //   const audioAcc = new this.api.platformAccessory(item.name, this.api.hap.uuid.generate(item.name), Categories.SPEAKER);
      //   this.api.publishExternalAccessories(PLUGIN_NAME, [audioAcc]);
      //   this.log.info(`[${item.name}] Add in Home app → + → More options. Same setup code as the bridge — regroup digits as XXXX-XXXX (4+4)`);
      //   beginAudioRoomAccessory(audioAcc, item);
      // } else if (item.proxy === "contactsingle_doorbell_c4") {
      //   this.log.info(`Found doorbell: ${item.name} (ID ${item.id})`);
      //   beginDoorbellAccessory(this.getAccessory(item.name), item);
      // } else if (item.proxy === "relaysingle_door_c4") {
      //   this.log.info(`Found door relay: ${item.name} (ID ${item.id})`);
      //   beginDoorRelayAccessory(this.getAccessory(item.name), item);
      // }
    }
  }

  private getAccessory(displayName: string, category?: number): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(displayName);
    const existing = this.accessories.find((a) => a.UUID === uuid);
    if (existing) {
      if (category !== undefined) existing.category = category;
      return existing;
    }
    const accessory = new this.api.platformAccessory(displayName, uuid, category);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    return accessory;
  }
}
