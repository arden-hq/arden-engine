import { createCliClient, resolveServer, type CliDependencies } from "./command.js"
import { failureOf } from "./run.js"

export interface ModelsOptions {
  readonly urlArgument: string | undefined
  readonly output: "text" | "json"
}

/**
 * `arden models`: the models a new chat may run on, as the server lists them.
 * On a configured server that is the settings' `model` and `extraModels`, or
 * the one model a llama.cpp server holds; the ids are what `--model` takes.
 */
export const modelsCommand = async (
  options: ModelsOptions,
  dependencies: CliDependencies
): Promise<number> => {
  try {
    const client = createCliClient(
      dependencies,
      await resolveServer(options.urlArgument, dependencies)
    )
    const catalog = await client.listModels()
    if (options.output === "json") {
      dependencies.writeStdout(
        `${JSON.stringify({ version: 1, type: "model_list", providers: catalog.providers })}\n`
      )
      return 0
    }
    for (const provider of catalog.providers) {
      for (const model of provider.models) {
        const efforts =
          model.reasoningEfforts.length === 0
            ? ""
            : `  efforts: ${model.reasoningEfforts.join(", ")}`
        dependencies.writeStdout(`${model.id}  ${provider.name}${efforts}\n`)
      }
    }
    return 0
  } catch (cause) {
    const failure = failureOf(cause)
    dependencies.writeStderr(`arden: ${failure.error.message}\n`)
    return failure.exitCode
  }
}
