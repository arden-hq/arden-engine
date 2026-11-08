export const latestSessionRunQuery = `
  SELECT candidate.run_id
  FROM chat_runs AS candidate
  WHERE candidate.session_id = s.session_id
  ORDER BY candidate.updated_at DESC, candidate.started_at DESC, candidate.run_id DESC
  LIMIT 1
`
