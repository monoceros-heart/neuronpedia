import { listTriggers } from '@/lib/db/trigger';
import { assertUserCanAccessModelAndSourceSet } from '@/lib/db/userCanAccess';
import { getSourceSetNameFromSource } from '@/lib/utils/source';
import { RequestOptionalUser, withOptionalUser } from '@/lib/with-user';
import { NextResponse } from 'next/server';
import { object, string } from 'yup';

const listTriggersSchema = object({
  modelId: string().required(),
  source: string().required(),
  index: string().required(),
});

/**
@swagger
{
  "/api/trigger/list": {
    "post": {
      "tags": ["Triggers"],
      "summary": "List Shared Triggers",
      "description": "Texts people have shared for a neuron or feature, strongest first, each with its author's proposed meaning, per-token activations, and its peak and trough as shares of the neuron's corpus extremes.",
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": ["modelId", "source", "index"],
              "properties": {
                "modelId": { "type": "string", "default": "qwen3-0.6b" },
                "source": { "type": "string", "default": "4" },
                "index": { "type": "string", "default": "396" }
              }
            }
          }
        }
      },
      "responses": { "200": { "description": "The neuron's shared triggers." } }
    }
  }
}
 */
export const POST = withOptionalUser(async (request: RequestOptionalUser) => {
  const body = await listTriggersSchema.validate(await request.json());
  await assertUserCanAccessModelAndSourceSet(body.modelId, getSourceSetNameFromSource(body.source), request.user);
  const triggers = await listTriggers({ modelId: body.modelId, layer: body.source, index: body.index });
  return NextResponse.json({ triggers });
});
