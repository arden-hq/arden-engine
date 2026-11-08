export interface WorkflowDeliveryIdentity {
  readonly workflowRef: string
  readonly attempt: number
}

const WORKFLOW_DELIVERY_CLIENT_PREFIX = "arden:workflow-result:v1:"

export const workflowDeliveryClientId = (identity: WorkflowDeliveryIdentity): string =>
  `${WORKFLOW_DELIVERY_CLIENT_PREFIX}${identity.workflowRef}:${identity.attempt}`

export const isWorkflowDeliveryClientId = (clientId: string): boolean =>
  clientId.startsWith(WORKFLOW_DELIVERY_CLIENT_PREFIX)
