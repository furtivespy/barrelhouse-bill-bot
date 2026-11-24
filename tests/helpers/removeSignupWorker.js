import DropStore from "../../src/db/drops.js";

self.onmessage = (event) => {
  const { sab, dataDir, dropId, userId, removedBy } = event.data;
  const gate = new Int32Array(sab);
  postMessage({ type: "ready" });
  Atomics.wait(gate, 0, 0);

  const store = new DropStore({ dataDir });
  let message;
  try {
    const result = store.removeSignup(dropId, userId, { removedBy });
    message = {
      type: "done",
      ok: true,
      userId: result.signup.userId,
      status: result.signup.status,
      alreadyRemoved: result.alreadyRemoved,
      promotedUserId: result.promoted?.userId ?? null,
    };
  } catch (error) {
    message = {
      type: "done",
      ok: false,
      name: error?.name,
      message: error?.message,
    };
  } finally {
    store.close();
  }
  postMessage(message);
};
