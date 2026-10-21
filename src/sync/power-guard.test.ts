import { describe, expect, test } from "bun:test";
import { evaluatePowerGuard, parseLowPowerMode, parsePowerGuardConfig, parsePowerSource } from "./power-guard";

describe("power guard", () => {
  test("is opt-in and validates require_ac_power", () => {
    expect(parsePowerGuardConfig(undefined)).toBe(false);
    expect(parsePowerGuardConfig({})).toBe(false);
    expect(parsePowerGuardConfig({ require_ac_power: true })).toBe(true);
    expect(() => parsePowerGuardConfig({ require_ac_power: "yes" })).toThrow(/must be a boolean/);
  });

  test("defers on battery or in Low Power Mode", () => {
    expect(evaluatePowerGuard({ onBattery: false, lowPowerMode: false })).toEqual({ skip: false });
    expect(evaluatePowerGuard({ onBattery: true, lowPowerMode: false })).toEqual({
      skip: true,
      reason: "Running on battery power",
    });
    expect(evaluatePowerGuard({ onBattery: false, lowPowerMode: true })).toEqual({
      skip: true,
      reason: "Low Power Mode is on",
    });
  });

  test("reads the power source from pmset -g batt", () => {
    expect(parsePowerSource("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t76%; charging;\n")).toBe(false);
    expect(parsePowerSource("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t52%; discharging;\n")).toBe(
      true
    );
    expect(parsePowerSource("Now drawing from 'UPS Power'\n")).toBe(true);
    expect(() => parsePowerSource("Now drawing from 'Solar Power'\n")).toThrow(/Unrecognized pmset/);
    expect(() => parsePowerSource("")).toThrow(/Unrecognized pmset/);
  });

  test("reads lowpowermode from pmset -g", () => {
    const settings = (value: number) =>
      `System-wide power settings:\nCurrently in use:\n standby              1\n lowpowermode         ${value}\n womp                 1\n`;
    expect(parseLowPowerMode(settings(0))).toBe(false);
    expect(parseLowPowerMode(settings(1))).toBe(true);
    expect(() => parseLowPowerMode("Currently in use:\n standby 1\n")).toThrow(/lowpowermode/);
  });

  test("reads powermode on Macs that offer High Power Mode", () => {
    const settings = (value: number) => `Currently in use:\n standby              1\n powermode            ${value}\n`;
    expect(parseLowPowerMode(settings(0))).toBe(false);
    expect(parseLowPowerMode(settings(1))).toBe(true);
    expect(parseLowPowerMode(settings(2))).toBe(false);
  });
});
