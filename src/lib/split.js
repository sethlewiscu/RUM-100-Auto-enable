import { getConfig } from "./config.js";

// Wrapper around the two Split.io (Harness) Segment change-request endpoints
// from the Postman collection:
//   1. createSegmentKeyCR  -> "Segment - Add Key API"
//   2. approveCR           -> "Segment - Approve Segment CR"

async function splitFetch(path, options = {}, token) {
  const { split } = getConfig();
  const res = await fetch(`${split.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token || split.apiToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Split ${options.method || "GET"} ${path} failed: ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

// Creates a change request that adds the given workspace keys to the RUM
// segment. Returns the parsed change request, from which we pull the id.
export async function createSegmentKeyCR(keys, { title, comment }) {
  const { split } = getConfig();
  const body = {
    segment: { name: split.segmentName, keys },
    operationType: "CREATE",
    title,
    comment,
    approvers: split.approvers,
  };

  const result = await splitFetch(
    `/changeRequests/ws/${split.wsId}/environments/${split.envId}`,
    { method: "POST", body: JSON.stringify(body) },
  );

  const crId = extractChangeRequestId(result);
  if (!crId) {
    throw new Error(
      `Could not find change request id in Split response: ${JSON.stringify(result)}`,
    );
  }
  return { crId, raw: result };
}

// Harness FME requires a *different* Admin API key (registered as an approver on
// the environment) to approve a change request than the one that created it.
export function approveCR(crId, comment = "CR approved via Admin API") {
  const { split } = getConfig();
  return splitFetch(
    `/changeRequests/${encodeURIComponent(crId)}`,
    { method: "PUT", body: JSON.stringify({ status: "APPROVED", comment }) },
    split.approveToken || split.apiToken,
  );
}

// The exact location of the id in the Add-Key response should be confirmed
// during the live dry-run (see plan Verification step 3). We check the most
// likely shapes so this is robust to either form.
export function extractChangeRequestId(response) {
  if (!response || typeof response !== "object") return null;
  return (
    response.id ||
    response.changeRequestId ||
    response.changeRequest?.id ||
    response.cr?.id ||
    null
  );
}
