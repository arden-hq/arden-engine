export const disposableForkSql = (alias: string): string =>
  `json_extract(${alias}.request_json, '$.disposition') = 'disposable'`
