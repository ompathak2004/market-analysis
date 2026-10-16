CREATE OR REPLACE VIEW influence_edges_confirmed AS
SELECT
  e.id,
  e.kind,
  e.confidence,
  e.version,
  e.resolver_version,
  e.valid_from,
  e.valid_to,
  e.created_at,
  e.updated_at,
  e.person_role_id,
  e.ownership_id,
  e.rpt_id,
  e.political_role_id,
  e.affidavit_interest_id,
  e.donation_id,
  e.policy_event_tag_id,
  e.from_node_id,
  f.kind AS from_kind,
  f.label AS from_label,
  f.company_id AS from_company_id,
  f.symbol AS from_symbol,
  f.person_id AS from_person_id,
  f.din AS from_din,
  f.counterparty_kind AS from_counterparty_kind,
  e.to_node_id,
  t.kind AS to_kind,
  t.label AS to_label,
  t.company_id AS to_company_id,
  t.symbol AS to_symbol,
  t.person_id AS to_person_id,
  t.din AS to_din,
  t.counterparty_kind AS to_counterparty_kind
FROM influence_edges e
JOIN graph_node_labels f ON f.node_id = e.from_node_id
JOIN graph_node_labels t ON t.node_id = e.to_node_id
WHERE e.status = 'confirmed'
  AND EXISTS (SELECT 1 FROM influence_edge_evidence ee WHERE ee.edge_id = e.id);--> statement-breakpoint
CREATE OR REPLACE FUNCTION review_influence_edge(
  p_edge_id bigint,
  p_decision text,
  p_reviewer text,
  p_note text,
  p_expected_version integer
) RETURNS TABLE (review_id integer, status text, version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_edge influence_edges%ROWTYPE;
  v_status influence_edge_status;
  v_version integer;
  v_review_id integer;
BEGIN
  IF p_reviewer IS NULL OR length(trim(p_reviewer)) = 0 THEN
    RAISE EXCEPTION 'reviewer required' USING ERRCODE = '22023';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('confirm', 'reject') THEN
    RAISE EXCEPTION 'invalid decision %', p_decision USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_edge FROM influence_edges WHERE id = p_edge_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'influence edge % not found', p_edge_id USING ERRCODE = 'P0002';
  END IF;
  IF v_edge.status = 'superseded' THEN
    RAISE EXCEPTION 'influence edge % is superseded', p_edge_id USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS NULL OR v_edge.version <> p_expected_version THEN
    RAISE EXCEPTION 'influence edge % version mismatch: expected %, found %', p_edge_id, p_expected_version, v_edge.version USING ERRCODE = '40001';
  END IF;
  IF p_decision = 'confirm' THEN
    IF NOT EXISTS (SELECT 1 FROM influence_edge_evidence ee WHERE ee.edge_id = p_edge_id) THEN
      RAISE EXCEPTION 'source citation required before confirming influence edge %', p_edge_id USING ERRCODE = '22023';
    END IF;
    v_status := 'confirmed';
    UPDATE influence_edges e SET status = 'superseded', version = e.version + 1, updated_at = now()
    WHERE e.from_node_id = v_edge.from_node_id
      AND e.to_node_id = v_edge.to_node_id
      AND e.kind = v_edge.kind
      AND e.status = 'confirmed'
      AND e.id <> v_edge.id;
  ELSE
    v_status := 'rejected';
  END IF;
  UPDATE influence_edges e SET status = v_status, version = e.version + 1, updated_at = now()
  WHERE e.id = p_edge_id
  RETURNING e.version INTO v_version;
  INSERT INTO influence_reviews (edge_id, decision, reviewer, note, edge_version)
  VALUES (p_edge_id, p_decision::influence_decision, p_reviewer, p_note, p_expected_version)
  RETURNING id INTO v_review_id;
  RETURN QUERY SELECT v_review_id, v_status::text, v_version;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION review_influence_edge(bigint, text, text, text, integer) FROM PUBLIC;
