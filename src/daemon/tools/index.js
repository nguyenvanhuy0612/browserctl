// @ts-check
// Every tool, in the order agents see them (specs/interface.md).
import { click, file_upload, fill_form, handle_dialog, hover, press_key, scroll, type } from "./act-tools.js";
import { evaluate, network_requests, run, take_screenshot } from "./other-tools.js";
import { read, snapshot, wait_for } from "./read-tools.js";
import { navigate, status, tabs } from "./session-tools.js";

export const tools = [
  status,
  tabs,
  navigate,
  snapshot,
  read,
  click,
  hover,
  type,
  fill_form,
  press_key,
  scroll,
  wait_for,
  take_screenshot,
  file_upload,
  handle_dialog,
  evaluate,
  run,
  network_requests,
];
