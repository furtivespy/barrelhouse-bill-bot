// End-to-end drop lifecycle fixture against real SQLite stores:
// /drop create (limit 1) -> user-1 In (allocated) -> user-2 In (waitlisted)
// -> /drop list -> /drop close.
export default async (ctx) => {
  const session = await ctx.session();
  await session.run("drop", {
    subcommand: "create",
    userId: "mod-1",
    strings: {
      bottle: "Blanton's Single Barrel",
      price: "$69.99",
      store: "Local Liquor",
    },
    integers: { limit: 1 },
  });

  const [drop] = session.drops.listDrops({ guildId: "guild-control-1" });
  await session.button(`drop:in:${drop.id}`, {
    userId: "user-1",
    actor: { mod: false, admin: false },
    messageId: drop.messageId,
  });
  await session.button(`drop:in:${drop.id}`, {
    userId: "user-2",
    actor: { mod: false, admin: false },
    messageId: drop.messageId,
  });
  await session.run("drop", { subcommand: "list", userId: "mod-1" });
  await session.run("drop", { subcommand: "close", userId: "mod-1" });

  return {
    dropStatus: session.drops.getDrop(drop.id).status,
    signups: session.drops.listSignups(drop.id).map((s) => ({
      userId: s.userId,
      status: s.status,
    })),
  };
};
