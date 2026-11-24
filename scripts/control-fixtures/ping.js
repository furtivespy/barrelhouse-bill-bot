// Basic smoke fixture: /ping slash command + pressing its Again button.
export default async (ctx) => {
  const session = await ctx.session();
  await session.run("ping");
  await session.button("ping:again");
};
