import { readFile, writeFile } from "node:fs/promises";

const sourcePath = process.argv[2] ?? new URL("./momentum-tool-contracts.json", import.meta.url);
const outputPath = process.argv[3] ?? null;
const jsonOutputPath = process.argv[4] ?? null;
const catalog = JSON.parse(await readFile(sourcePath, "utf8"));
const toolNames = new Set(catalog.tools.map((tool) => tool.name));
const writePrefix = /^(insert|update|apply|remove|send|create|bulk_insert)/;

function readbacks(name) {
  const pairs = [
    [/insured_prospect|bulk_insert_insured/, ["get_insured_details_tool", "get_insured_detail_list_tool"]],
    [/service_request/, ["get_service_request_details_tool"]],
    [/driver/, ["get_driver_list_tool", "get_insured_contact_details_tool"]],
    [/vehicle/, ["get_vehicle_list_tool"]],
    [/note/, ["get_notes_list_tool"]],
    [/quote|policy_coverages|insert_policy/, ["get_policy_list_tool", "get_policy_details_by_database_id_tool"]],
    [/property_location|acord_80/, ["get_property_list_tool", "get_insured_location_list_tool"]],
    [/opportunity/, ["get_opportunity_list_tool"]],
    [/task/, ["get_task_list_tool"]],
    [/certificate_holder/, ["get_certificate_holder_details_tool"]],
    [/insured_tag/, ["get_insured_tags_tool"]],
    [/policy_tag|bulk_tag/, ["get_policy_tags_tool"]],
    [/primary_contact/, ["get_insured_contact_details_tool"]],
    [/claim/, ["get_claim_list_tool", "get_loss_claims_details_for_insured_tool"]],
    [/insured_policy_file/, ["get_policy_files_list_tool"]],
    [/equipment/, ["get_equipment_detail_list_tool"]],
    [/cl_rating_data/, ["get_additional_details_for_insured_tool", "get_insured_detail_list_tool"]],
  ];
  return (pairs.find(([pattern]) => pattern.test(name))?.[1] ?? []).filter((item) => toolNames.has(item));
}

const rows = catalog.tools.filter((tool) => writePrefix.test(tool.name)).map((tool) => {
  const schema = tool.inputSchema ?? {};
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const errors = [];
  if (schema.type !== "object") errors.push("input schema is not an object");
  if (!Object.keys(properties).length) errors.push("no input fields declared");
  const unknownRequired = required.filter((field) => !(field in properties));
  if (unknownRequired.length) errors.push(`required fields missing from properties: ${unknownRequired.join(", ")}`);
  if ((tool.name.startsWith("update_") || tool.name.startsWith("remove_")) && !required.length) errors.push("mutation declares no required fields");
  const reads = readbacks(tool.name);
  if (!reads.length) errors.push("no deterministic read-back tool mapped");
  return {
    tool: tool.name,
    field_count: Object.keys(properties).length,
    required_count: required.length,
    required,
    read_back_tools: reads,
    status: errors.length ? "BLOCKED" : "SCHEMA_ALIGNED",
    errors,
  };
});

const aligned = rows.filter((row) => row.status === "SCHEMA_ALIGNED").length;
const report = {
  source: "Official Momentum MCP tools/list",
  total_tools: catalog.tools.length,
  writable_tools: rows.length,
  schema_aligned: aligned,
  blocked: rows.length - aligned,
  note: "SCHEMA_ALIGNED verifies the declared input and a read-back route. It does not enable writes; live certification still requires a reversible sandbox call, pre-write reread, idempotency, and post-write value comparison.",
  contracts: rows,
};

const markdown = [
  "# Momentum Writable Contract Audit",
  "",
  `Official tools: ${report.total_tools} · Writable: ${report.writable_tools} · Schema-aligned: ${report.schema_aligned} · Blocked: ${report.blocked}`,
  "",
  report.note,
  "",
  "| Tool | Fields | Required | Read-back | Status / blocker |",
  "|---|---:|---:|---|---|",
  ...rows.map((row) => `| \`${row.tool}\` | ${row.field_count} | ${row.required_count} | ${row.read_back_tools.map((item) => `\`${item}\``).join("<br>") || "—"} | ${row.status === "SCHEMA_ALIGNED" ? "SCHEMA_ALIGNED" : row.errors.join("; ")} |`),
  "",
].join("\n");

if (outputPath) await writeFile(outputPath, markdown, "utf8");
if (jsonOutputPath) await writeFile(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ total_tools: report.total_tools, writable_tools: report.writable_tools, schema_aligned: report.schema_aligned, blocked: report.blocked }));
