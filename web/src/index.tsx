/* @refresh reload */
import { render } from "solid-js/web";
import { onCleanup } from "solid-js";
import { QueryClientProvider } from "@tanstack/solid-query";
import { setWorkerUrl } from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import {
  mountAfterQueryClientRestore,
  queryClient,
  queryClientRestoration,
  unsubscribeQueryClientPersistence,
} from "./lib/query-client";
import "@fontsource-variable/fraunces/index.css";
import "@fontsource-variable/inter/standard.css";
import "@fontsource-variable/inter/standard-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./app.css";
import App from "./App";

setWorkerUrl(mapWorkerUrl);

const root = document.getElementById("app");

if (!root) throw new Error("Root element not found");
const appRoot = root;

function mountApp() {
  render(
    () => {
      onCleanup(unsubscribeQueryClientPersistence);
      return (
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      );
    },
    appRoot,
  );
}

void mountAfterQueryClientRestore(queryClientRestoration, mountApp);
