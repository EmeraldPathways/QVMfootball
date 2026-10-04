import { getRequestExecutionContext } from "vinext/shims/request-context";
import { getDb } from "../../../../db";
import {
  continueHostedOnlineCycle,
  runHostedOnlineCycleStep,
  startHostedOnlineCycle,
} from "../../../../lib/online-cycle";

export async function POST(request: Request) {
  try {
    const db = await getDb();
    const url = new URL(request.url);
    const isContinuation = url.searchParams.get("continue") === "1";
    if (isContinuation) {
      if (request.headers.get("X-QVM-Cycle-Continuation") !== "1") {
        return Response.json({ error: "Invalid hosted cycle continuation." }, { status: 400 });
      }
      const startedAt = url.searchParams.get("startedAt");
      if (!startedAt) {
        return Response.json({ error: "Hosted cycle continuation is missing its start time." }, { status: 400 });
      }
      const executionContext = getRequestExecutionContext();
      if (executionContext) {
        const cycle = continueHostedOnlineCycle(db, request.url, startedAt).catch((error) => {
          console.error("Hosted online QVM cycle continuation failed.", error);
        });
        executionContext.waitUntil(cycle);
        return Response.json({ status: "RUNNING", startedAt }, { status: 202 });
      }
      return Response.json(await continueHostedOnlineCycle(db, request.url, startedAt));
    }

    const startedAt = new Date().toISOString();
    const requestId = request.headers.get("X-QVM-Request-ID");
    const startResult = await startHostedOnlineCycle(db, startedAt, requestId);
    if (startResult.status === "RUNNING") {
      return Response.json(startResult, { status: 202 });
    }
    const executionContext = getRequestExecutionContext();
    if (executionContext) {
      const cycle = continueHostedOnlineCycle(db, request.url, startedAt).catch((error) => {
        console.error("Hosted online QVM cycle failed in the background.", error);
      });
      executionContext.waitUntil(cycle);
      return Response.json(
        {
          ...startResult,
        },
        { status: 202 },
      );
    }

    let result = await runHostedOnlineCycleStep(db, startedAt);
    while (result.next) result = await runHostedOnlineCycleStep(db, startedAt);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hosted online cycle failed.";
    return Response.json({ error: message }, { status: 503 });
  }
}
