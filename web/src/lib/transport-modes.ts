import type { Component } from "solid-js";
import {
  IconCommute,
  IconDirectionsBoat,
  IconDirectionsBus,
  IconDirectionsCar,
  IconFlight,
  IconLocalTaxi,
  IconSubway,
  IconTrain,
  IconTram,
} from "../ui/icons";

type TransportIcon = Component<{ class?: string; "aria-hidden"?: boolean }>;

export interface TransportMode {
  value: string;
  label: string;
  icon: TransportIcon;
  color: string;
}

/** Modes offered by the transport composer, and used to render `transport:*` events. */
export const TRANSPORT_MODES: readonly TransportMode[] = [
  { value: "train", label: "Train", icon: IconTrain, color: "#2563eb" },
  { value: "flight", label: "Flight", icon: IconFlight, color: "#7c3aed" },
  { value: "bus", label: "Bus", icon: IconDirectionsBus, color: "#059669" },
  { value: "taxi", label: "Taxi", icon: IconLocalTaxi, color: "#d97706" },
  { value: "car", label: "Car", icon: IconDirectionsCar, color: "#6b7280" },
  { value: "tube", label: "Tube", icon: IconSubway, color: "#dc2626" },
  { value: "ferry", label: "Ferry", icon: IconDirectionsBoat, color: "#0891b2" },
  { value: "tram", label: "Tram", icon: IconTram, color: "#4f46e5" },
];

const UNKNOWN_MODE: TransportMode = {
  value: "transport",
  label: "Transport",
  icon: IconCommute,
  color: "#6b7280",
};

/** Falls back to a generic mode so events written by other tools still render. */
export function getTransportMode(value: string): TransportMode {
  return TRANSPORT_MODES.find((m) => m.value === value) ?? UNKNOWN_MODE;
}
