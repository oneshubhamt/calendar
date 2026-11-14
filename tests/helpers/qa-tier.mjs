import test from "node:test";

const lane = process.env.CALENDAR_QA_NODE_LANE ?? "full";
if (!["fast", "full"].includes(lane)) throw new Error(`Unknown Node QA lane: ${lane}`);

export function deepTest(name, body) {
  return test(name, { skip: lane === "fast" }, body);
}
