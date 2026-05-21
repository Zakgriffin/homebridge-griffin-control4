import { PlatformAccessory } from "homebridge";
import { C4Item } from "./control4";
import { platform } from "./platform";

const fahrenheitToCelsius = (f: number) => (f - 32) * 5 / 9;
const celsiusToFahrenheit = (c: number) => Math.round(c * 9 / 5 + 32);

const HVAC_MODE_TO_HAP: Record<string, number> = { "Off": 0, "Heat": 1, "Cool": 2, "Auto": 3 };
const HAP_TO_HVAC_MODE: Record<number, string> = { 0: "Off", 1: "Heat", 2: "Cool", 3: "Auto" };

export function beginThermostatAccessory(accessory: PlatformAccessory, item: C4Item) {
  const { control4, api, log, config } = platform;
  const { Characteristic, Service } = api.hap;
  const { OFF, HEAT, COOL } = Characteristic.CurrentHeatingCoolingState;

  const service = accessory.getService(Service.Thermostat) ?? accessory.addService(Service.Thermostat);

  let currentTemp = fahrenheitToCelsius(70);
  let targetTemp = fahrenheitToCelsius(72);
  let currentMode = OFF;
  let targetMode = OFF;

  service
    .getCharacteristic(Characteristic.CurrentTemperature)
    .onGet(() => currentTemp);

  service
    .getCharacteristic(Characteristic.TargetTemperature)
    .setProps({ minValue: fahrenheitToCelsius(50), maxValue: fahrenheitToCelsius(99), minStep: 0.5 })
    .onGet(() => targetTemp)
    .onSet(async (value) => {
      const tempF = celsiusToFahrenheit(value as number);
      if (targetMode === Characteristic.TargetHeatingCoolingState.HEAT || targetMode === Characteristic.TargetHeatingCoolingState.AUTO) {
        await control4.sendCommand(item.id, "SET_SETPOINT_HEAT", { FAHRENHEIT: tempF });
      }
      if (targetMode === Characteristic.TargetHeatingCoolingState.COOL || targetMode === Characteristic.TargetHeatingCoolingState.AUTO) {
        await control4.sendCommand(item.id, "SET_SETPOINT_COOL", { FAHRENHEIT: tempF });
      }
    });

  service
    .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .setProps({ validValues: [OFF, HEAT, COOL] })
    .onGet(() => currentMode);

  service
    .getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .onGet(() => targetMode)
    .onSet(async (value) => {
      await control4.sendCommand(item.id, "SET_MODE_HVAC", { MODE: HAP_TO_HVAC_MODE[value as number] ?? "Off" });
    });

  const INTERVAL = ((config.telemetryIntervalSeconds as number | undefined) ?? 60) * 1000;

  async function poll() {
    try {
      const [tempF, heatSetF, coolSetF, hvacMode, hvacState] = await Promise.all([
        control4.getVariable(item.id, "TEMPERATURE_F"),
        control4.getVariable(item.id, "HEAT_SETPOINT_F"),
        control4.getVariable(item.id, "COOL_SETPOINT_F"),
        control4.getVariable(item.id, "HVAC_MODE"),
        control4.getVariable(item.id, "HVAC_STATE"),
      ]);

      currentTemp = fahrenheitToCelsius(parseFloat(tempF) || 70);
      targetMode = HVAC_MODE_TO_HAP[hvacMode] ?? OFF;
      targetTemp = fahrenheitToCelsius(
        targetMode === Characteristic.TargetHeatingCoolingState.COOL
          ? (parseFloat(coolSetF) || 72)
          : (parseFloat(heatSetF) || 72)
      );

      const stateLower = hvacState.toLowerCase();
      if (stateLower.includes("cool")) currentMode = COOL;
      else if (stateLower.includes("heat") || stateLower.includes("comp")) currentMode = HEAT;
      else currentMode = OFF;

      service.updateCharacteristic(Characteristic.CurrentTemperature, currentTemp);
      service.updateCharacteristic(Characteristic.TargetTemperature, targetTemp);
      service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, currentMode);
      service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, targetMode);
    } catch (err) {
      log.error(`[${item.name}] poll error:`, (err as Error).message);
    }
    setTimeout(poll, INTERVAL);
  }

  poll();
}
