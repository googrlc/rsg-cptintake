# Momentum Writable Contract Audit

Official tools: 95 · Writable: 49 · Schema-aligned: 44 · Blocked: 5

SCHEMA_ALIGNED verifies the declared input and a read-back route. It does not enable writes; live certification still requires a reversible sandbox call, pre-write reread, idempotency, and post-write value comparison.

| Tool | Fields | Required | Read-back | Status / blocker |
|---|---:|---:|---|---|
| `insert_insured_prospect_tool` | 11 | 6 | `get_insured_details_tool`<br>`get_insured_detail_list_tool` | SCHEMA_ALIGNED |
| `insert_driver_tool` | 15 | 13 | `get_driver_list_tool`<br>`get_insured_contact_details_tool` | SCHEMA_ALIGNED |
| `insert_vehicle_tool` | 7 | 6 | `get_vehicle_list_tool` | SCHEMA_ALIGNED |
| `insert_note_tool` | 3 | 1 | `get_notes_list_tool` | SCHEMA_ALIGNED |
| `insert_quote_tool` | 8 | 5 | `get_policy_list_tool`<br>`get_policy_details_by_database_id_tool` | SCHEMA_ALIGNED |
| `insert_policy_tool` | 9 | 5 | `get_policy_list_tool`<br>`get_policy_details_by_database_id_tool` | SCHEMA_ALIGNED |
| `insert_policy_coverages_tool` | 2 | 2 | `get_policy_list_tool`<br>`get_policy_details_by_database_id_tool` | SCHEMA_ALIGNED |
| `insert_property_location_tool` | 13 | 9 | `get_property_list_tool`<br>`get_insured_location_list_tool` | SCHEMA_ALIGNED |
| `update_vehicle_tool` | 13 | 3 | `get_vehicle_list_tool` | SCHEMA_ALIGNED |
| `update_driver_tool` | 15 | 1 | `get_driver_list_tool`<br>`get_insured_contact_details_tool` | SCHEMA_ALIGNED |
| `insert_opportunity_tool` | 8 | 4 | `get_opportunity_list_tool` | SCHEMA_ALIGNED |
| `insert_task_tool` | 9 | 1 | `get_task_list_tool` | SCHEMA_ALIGNED |
| `update_task_tool` | 8 | 1 | `get_task_list_tool` | SCHEMA_ALIGNED |
| `insert_task_bulk_tool` | 1 | 1 | `get_task_list_tool` | SCHEMA_ALIGNED |
| `insert_certificate_holder_tool` | 8 | 7 | `get_certificate_holder_details_tool` | SCHEMA_ALIGNED |
| `send_certificate_tool` | 6 | 3 | — | no deterministic read-back tool mapped |
| `apply_insured_tag_tool` | 4 | 1 | `get_insured_tags_tool` | SCHEMA_ALIGNED |
| `remove_insured_tag_tool` | 2 | 2 | `get_insured_tags_tool` | SCHEMA_ALIGNED |
| `remove_policy_tag_tool` | 2 | 0 | `get_policy_tags_tool` | mutation declares no required fields |
| `apply_policy_tag_tool` | 3 | 3 | `get_policy_tags_tool` | SCHEMA_ALIGNED |
| `insert_bulk_tag_for_policies_in_ams_tool` | 1 | 1 | `get_policy_tags_tool` | SCHEMA_ALIGNED |
| `bulk_insert_driver_tool` | 3 | 1 | `get_driver_list_tool`<br>`get_insured_contact_details_tool` | SCHEMA_ALIGNED |
| `bulk_insert_vehicle_tool` | 3 | 1 | `get_vehicle_list_tool` | SCHEMA_ALIGNED |
| `insert_service_request_tool` | 23 | 3 | `get_service_request_details_tool` | SCHEMA_ALIGNED |
| `update_service_request_tool` | 24 | 4 | `get_service_request_details_tool` | SCHEMA_ALIGNED |
| `insert_or_update_service_request_coi_tool` | 22 | 3 | `get_service_request_details_tool` | SCHEMA_ALIGNED |
| `insert_or_update_service_request_general_tool` | 17 | 3 | `get_service_request_details_tool` | SCHEMA_ALIGNED |
| `insert_or_update_service_request_generic_tool` | 14 | 2 | `get_service_request_details_tool` | SCHEMA_ALIGNED |
| `insert_or_update_service_request_replace_vehicle_tool` | 21 | 4 | `get_service_request_details_tool` | SCHEMA_ALIGNED |
| `insert_or_update_service_request_policy_change_tool` | 15 | 3 | `get_service_request_details_tool` | SCHEMA_ALIGNED |
| `insert_or_update_service_request_add_driver_tool` | 31 | 1 | `get_service_request_details_tool` | SCHEMA_ALIGNED |
| `insert_or_update_service_request_address_change_tool` | 14 | 1 | `get_service_request_details_tool` | SCHEMA_ALIGNED |
| `insert_or_update_service_request_remove_driver_tool` | 14 | 2 | `get_service_request_details_tool` | SCHEMA_ALIGNED |
| `insert_or_update_service_request_replace_driver_tool` | 15 | 3 | `get_service_request_details_tool` | SCHEMA_ALIGNED |
| `insert_or_update_service_request_vehicle_transfer_tool` | 13 | 1 | `get_service_request_details_tool` | SCHEMA_ALIGNED |
| `insert_or_update_service_request_add_vehicle_tool` | 25 | 1 | `get_service_request_details_tool` | SCHEMA_ALIGNED |
| `bulk_insert_insured_tool` | 1 | 1 | `get_insured_details_tool`<br>`get_insured_detail_list_tool` | SCHEMA_ALIGNED |
| `update_opportunity_tool` | 9 | 5 | `get_opportunity_list_tool` | SCHEMA_ALIGNED |
| `insert_insured_prospect_primary_contact_in_ams_tool` | 27 | 3 | `get_insured_details_tool`<br>`get_insured_detail_list_tool` | SCHEMA_ALIGNED |
| `insert_claim_tool` | 12 | 1 | `get_claim_list_tool`<br>`get_loss_claims_details_for_insured_tool` | SCHEMA_ALIGNED |
| `insert_insured_file_tool` | 3 | 3 | — | no deterministic read-back tool mapped |
| `insert_insured_policy_file_tool` | 5 | 4 | `get_policy_files_list_tool` | SCHEMA_ALIGNED |
| `insert_equipment_tool` | 14 | 1 | `get_equipment_detail_list_tool` | SCHEMA_ALIGNED |
| `bulk_insert_equipment_tool` | 1 | 1 | `get_equipment_detail_list_tool` | SCHEMA_ALIGNED |
| `send_email_tool` | 5 | 3 | — | no deterministic read-back tool mapped |
| `update_property_location_tool` | 14 | 10 | `get_property_list_tool`<br>`get_insured_location_list_tool` | SCHEMA_ALIGNED |
| `update_cl_rating_data_tool` | 9 | 1 | `get_additional_details_for_insured_tool`<br>`get_insured_detail_list_tool` | SCHEMA_ALIGNED |
| `update_acord_80_data_in_ams_tool` | 14 | 2 | `get_property_list_tool`<br>`get_insured_location_list_tool` | SCHEMA_ALIGNED |
| `create_acord_form_tool` | 15 | 3 | — | no deterministic read-back tool mapped |
