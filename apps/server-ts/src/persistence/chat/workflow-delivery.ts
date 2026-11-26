export interface WorkflowDeliveryIdentity {
  readonly workflowRef: string
  readonly attempt: number
}

const WORKFLOW_DELIVERY_CLIENT_PREFIX = "arden:workflow-result:v1:"

export const workflowDeliveryClientId = (identity: WorkflowDeliveryIdentity): string =>
  `${WORKFLOW_DELIVERY_CLIENT_PREFIX}${identity.workflowRef}:${identity.attempt}`

export const CLIENT_ID_NAMESPACE = {
  workflowDelivery: "workflow_delivery",
  client: "client"
} as const

export type ClientIdNamespace = (typeof CLIENT_ID_NAMESPACE)[keyof typeof CLIENT_ID_NAMESPACE]

export const clientIdNamespace = (clientId: string): ClientIdNamespace =>
  clientId.startsWith(WORKFLOW_DELIVERY_CLIENT_PREFIX)
    ? CLIENT_ID_NAMESPACE.workflowDelivery
    : CLIENT_ID_NAMESPACE.client
