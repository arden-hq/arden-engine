export const sessionOriginQuery = `
  CASE
    WHEN json_extract(s.metadata, '$.capture.at') IS NOT NULL THEN 'capture'
    WHEN json_extract(s.metadata, '$.onboarding.at') IS NOT NULL THEN 'onboarding'
  END
`
