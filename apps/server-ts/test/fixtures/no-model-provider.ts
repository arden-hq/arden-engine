import { Layer } from "effect"
import { ModelProviderService } from "../../src/models/provider.js"
import { StructuredCompletion } from "../../src/models/structured-completion.js"

export const noModelProvider = StructuredCompletion.layer.pipe(
  Layer.provideMerge(ModelProviderService.layer({ provider: undefined }))
)
