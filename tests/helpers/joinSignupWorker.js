import DropStore from "../../src/db/drops.js";

onmessage = (event) => {
  const { sab, dataDir, dropId, userId } = event.data;
  const gate = new Int32Array(sab);
  postMessage({ type: "ready" });
  Atomics.wait(gate, 0, 0);

  const store = new DropStore({ dataDir });
  try {
    const result = store.joinSignup(dropId, userId);
    postMessage({
      type: "done",
      ok: true,
      created: result.created,
      status: result.signup.status,
      userId: result.signup.userId,
      position: result.position,
    });
  } catch (error) {
    postMessage({
      type: "done",
      ok: false,
      name: error?.name,
      message: error?.message,
    });
  } finally {
    store.close();
  }
};
