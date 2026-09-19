export async function POST() {
  return Response.json(
    {
      error: "The Windows worker bridge is retired. Run the hosted online cycle from AI Ops instead.",
    },
    { status: 410 },
  );
}
