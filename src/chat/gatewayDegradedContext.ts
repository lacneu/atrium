import { createContext } from "react";

// True when the CHAT's routed instance has a gateway target in `error` state while
// the bridge itself is up (getBridgeAvailability.degraded, instance-scoped). Lives in
// its own module so RunStatus can consume it without a circular import back into
// ConvexChat. Drives the HONEST in-flight labels: without it a dead gateway leaves
// the thinking dots reading "…traite votre message" until the watchdog timeout.
export const GatewayDegradedContext = createContext<boolean>(false);
