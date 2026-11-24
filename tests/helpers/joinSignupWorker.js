import DropStore from "../../src/db/drops.js";

self.onmessage = (event) => {
  const { sab, dataDir, dropId, userId } = event.data;
  const gate = new Int32Array(sab);
  postMessage({ type: "ready" });
  Atomics.wait(gate, 0, 0);

  const store = new DropStore({ dataDir });
  let message;
  try {
    const result = store.joinSignup(dropId, userId);
    message = {
      type: "done",
      ok: true,
      created: result.created,
      status: result.signup.status,
      userId: result.signup.userId,
      position: result.position,
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
