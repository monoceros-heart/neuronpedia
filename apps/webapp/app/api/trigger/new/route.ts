import { createTrigger } from '@/lib/db/trigger';
import { assertUserCanAccessModelAndSourceSet } from '@/lib/db/userCanAccess';
import { TRIGGER_MAX_MEANING_LENGTH, TRIGGER_MAX_TEXT_LENGTH } from '@/lib/utils/raw-neurons';
import { getSourceSetNameFromSource } from '@/lib/utils/source';
import { RequestAuthedUser, withAuthedUser } from '@/lib/with-user';
import { NextResponse } from 'next/server';
import { object, string } from 'yup';

const newTriggerSchema = object({
  modelId: string().required(),
  source: string().required(),
  index: string().required(),
  text: string().trim().required().max(TRIGGER_MAX_TEXT_LENGTH),
  meaning: string().trim().required().max(TRIGGER_MAX_MEANING_LENGTH),
});

/**
@swagger
{
  "/api/trigger/new": {
    "post": {
      "tags": ["Triggers"],
      "summary": "Share a Trigger",
      "security": [{ "apiKey": [] }],
      "description": "Runs your text through one neuron or feature and shares it, with what you think the neuron means, on its page. The activation values are computed by the server. The response includes the text's peak as a share of the neuron's strongest corpus example (`peakShare`); 0.3 or more counts as a strong response.",
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": ["modelId", "source", "index", "text", "meaning"],
              "properties": {
                "modelId": { "type": "string", "default": "qwen3-0.6b" },
                "source": { "type": "string", "description": "Layer for a raw neuron (e.g. 4), or SAE ID.", "default": "4" },
                "index": { "type": "string", "default": "396" },
                "text": { "type": "string", "description": "Text meant to activate the neuron." },
                "meaning": { "type": "string", "description": "What you think the neuron responds to." }
              }
            }
          }
        }
      },
      "responses": { "200": { "description": "The shared trigger." } }
    }
  }
}
 */
export const POST = withAuthedUser(async (request: RequestAuthedUser) => {
  const body = await newTriggerSchema.validate(await request.json());
  await assertUserCanAccessModelAndSourceSet(body.modelId, getSourceSetNameFromSource(body.source), request.user);
  const trigger = await createTrigger(
    { modelId: body.modelId, layer: body.source, index: body.index },
    body.text,
    body.meaning,
    request.user,
  );
  return NextResponse.json(trigger);
});
