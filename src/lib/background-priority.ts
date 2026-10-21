/**
 * Background priority for sync and import work on macOS. A background thread
 * runs on the efficiency cores with throttled disk I/O, so it stays out of the
 * way of the API and the user's apps. Child processes do not inherit a
 * thread's priority, so commands spawned from a lowered thread run through
 * `taskpolicy -b`.
 *
 * Module state is per thread: each Bun worker loads its own copy of this
 * module, so only commands spawned from the lowered thread are wrapped.
 */

import { dlopen, FFIType } from "bun:ffi";

/** QOS_CLASS_BACKGROUND from <sys/qos.h>. */
const QOS_CLASS_BACKGROUND = 0x09;

let lowered = false;

/** Lower the calling thread to background priority. Other platforms have no equivalent and run unchanged. */
export function lowerThreadToBackground(): void {
  if (process.platform !== "darwin") return;
  const { symbols, close } = dlopen("/usr/lib/libSystem.B.dylib", {
    pthread_set_qos_class_self_np: { args: [FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  });
  try {
    const status = symbols.pthread_set_qos_class_self_np(QOS_CLASS_BACKGROUND, 0);
    if (status !== 0) throw new Error(`pthread_set_qos_class_self_np failed with status ${status}`);
  } finally {
    close();
  }
  lowered = true;
}

/** The command to spawn so it runs at the calling thread's priority. */
export function backgroundCommand(command: readonly [string, ...string[]]): [string, ...string[]] {
  return lowered ? ["/usr/sbin/taskpolicy", "-b", ...command] : [...command];
}
