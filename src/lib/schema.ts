/**
 * The lesson-plan domain model.
 *
 * The reference UC3 returned four fields — title, overview, an empty syllabus
 * array, and a blob of handout text — and threw away everything a teacher
 * actually walks into a room with. This schema is written from the other end:
 * what does a Buddhist studies teacher need on the page to run a real session?
 *
 * Everything here is a Zod schema so it can double as the structured-output
 * contract for the model (via the AI SDK's `generateObject`). That is the fix
 * for the original code's prompt/parser mismatch: instead of asking for prose
 * and then string-splitting on markers the prompt never required, we hand the
 * model a schema and get typed JSON back.
 */

import { z } from "zod";

// -- request ----------------------------------------------------------------

export const TRADITIONS = [
  "Theravada",
  "Mahayana",
  "Vajrayana",
  "Zen",
  "Pure Land",
  "Secular / Non-sectarian",
] as const;

export const AUDIENCE_LEVELS = ["beginner", "intermediate", "advanced"] as const;
export const FORMATS = ["online", "IRL", "hybrid"] as const;

export const LessonPlanRequestSchema = z.object({
  topic: z.string().min(2, "Give a topic to teach."),
  audience: z.enum(AUDIENCE_LEVELS),
  durationMinutes: z.number().int().min(15).max(240),
  learningObjectives: z
    .array(z.string().min(3))
    .min(1, "At least one learning objective is required.")
    .max(8),
  format: z.enum(FORMATS),
  tradition: z.enum(TRADITIONS).default("Secular / Non-sectarian"),
  /** Optional free-text the teacher wants folded in (audience notes, constraints). */
  notes: z.string().optional(),
});

export type LessonPlanRequest = z.infer<typeof LessonPlanRequestSchema>;

// -- building blocks --------------------------------------------------------

const BLOOM_LEVELS = [
  "remember",
  "understand",
  "apply",
  "analyze",
  "evaluate",
  "create",
] as const;

export const ObjectiveSchema = z.object({
  objective: z.string().describe("A single measurable learning objective."),
  bloomLevel: z
    .enum(BLOOM_LEVELS)
    .describe("Bloom's taxonomy level this objective targets."),
});

export const KeyTermSchema = z.object({
  term: z.string(),
  paliSanskrit: z
    .string()
    .nullable()
    .describe("The Pali/Sanskrit/original term if applicable, else null."),
  definition: z.string().describe("A plain-language definition for this audience level."),
});

const ACTIVITY_TYPES = [
  "opening",
  "teaching",
  "meditation",
  "discussion",
  "reflection",
  "q_and_a",
  "activity",
  "break",
  "closing",
] as const;

export const AgendaItemSchema = z.object({
  startMinute: z.number().int().min(0).describe("Minutes from session start."),
  durationMinutes: z.number().int().min(1),
  activityType: z.enum(ACTIVITY_TYPES),
  title: z.string(),
  description: z.string().describe("What actually happens in this block."),
  teacherNotes: z
    .string()
    .describe("Facilitation guidance: pacing, tone, what to watch for."),
  linkedObjectiveIndexes: z
    .array(z.number().int())
    .describe("Indexes into learningObjectives that this block advances. May be empty for opening/closing."),
});

export const TalkingPointSchema = z.object({
  point: z.string(),
  sourceIds: z
    .array(z.string())
    .describe("IDs (e.g. 'S1') of retrieved sources that ground this point. Empty if the point is pedagogical framing, not a scriptural claim."),
});

export const MisconceptionSchema = z.object({
  misconception: z.string().describe("A common misunderstanding at this level."),
  skillfulReframe: z.string().describe("How to gently correct it."),
});

const PRACTICE_TYPES = [
  "breath",
  "metta",
  "body_scan",
  "analytical",
  "reflection",
  "walking",
  "chanting",
] as const;

export const GuidedPracticeSchema = z.object({
  title: z.string(),
  type: z.enum(PRACTICE_TYPES),
  durationMinutes: z.number().int().min(1),
  script: z
    .string()
    .describe("A ready-to-read guided-practice script, paragraphs separated by blank lines, with natural pauses noted as '(pause)'."),
  accessibilityNotes: z
    .string()
    .describe("Adaptations for people who cannot sit/close eyes/etc.; trauma-informed cautions."),
});

export const CitationSchema = z.object({
  id: z.string().describe("Stable source id, e.g. 'S1', matching the retrieved sources."),
  title: z.string(),
  reference: z
    .string()
    .describe("A human-readable citation (text name + section/verse if known)."),
  translationStatus: z.string(),
  score: z.number(),
  /** Filled in by the server AFTER generation — the model never sets this. */
  groundingStatus: z
    .enum(["verified", "partial", "unverified"])
    .default("unverified"),
});

export const HandoutPassageSchema = z.object({
  sourceId: z.string().describe("Which retrieved source this quote comes from."),
  reference: z.string(),
  quote: z
    .string()
    .describe("A quotation that MUST appear (near-verbatim) in the retrieved source content. Do not paraphrase into quotation marks."),
});

// -- the plan ---------------------------------------------------------------

export const LessonPlanSchema = z.object({
  title: z.string(),
  subtitle: z.string().describe("One evocative line describing the session."),
  tradition: z.enum(TRADITIONS),
  summary: z.string().describe("A 2–3 sentence overview for the teacher."),

  learningObjectives: z.array(ObjectiveSchema).min(1),
  keyTerms: z.array(KeyTermSchema),

  materialsAndPrep: z.object({
    teacher: z.array(z.string()),
    students: z.array(z.string()),
    roomSetup: z.string().describe("IRL room/cushion/altar setup, or 'n/a'."),
    techSetup: z.string().describe("Online tooling (video, breakout rooms, shared doc), or 'n/a'."),
  }),

  agenda: z.array(AgendaItemSchema).min(2),

  coreTeaching: z.object({
    talkingPoints: z.array(TalkingPointSchema).min(1),
    commonMisconceptions: z.array(MisconceptionSchema),
  }),

  guidedPractice: GuidedPracticeSchema,

  discussionQuestions: z.object({
    pair: z.array(z.string()).describe("Prompts for pairs / breakout rooms."),
    group: z.array(z.string()).describe("Prompts for the full circle."),
  }),

  differentiation: z.object({
    forBeginners: z.string(),
    forAdvanced: z.string(),
    traumaInformed: z.string().describe("Cautions for difficult material / meditation."),
    accessibility: z.string(),
  }),

  formatAdaptation: z.object({
    online: z.string(),
    inPerson: z.string(),
  }),

  assessment: z
    .array(
      z.object({
        checkForUnderstanding: z.string(),
        linkedObjectiveIndex: z.number().int(),
      }),
    )
    .describe("Lightweight, non-graded checks tied to each objective."),

  homePractice: z.object({
    assignment: z.string(),
    dailyPractice: z.string(),
    reflectionPrompt: z.string(),
  }),

  studentHandout: z.object({
    intro: z.string(),
    passages: z.array(HandoutPassageSchema),
    reflectionPrompts: z.array(z.string()),
  }),

  closing: z.object({
    dedicationOfMerit: z.string().describe("A short closing dedication appropriate to the tradition."),
    nextSessionPreview: z.string(),
  }),

  facilitatorTips: z.array(z.string()),

  citations: z.array(CitationSchema),
});

export type LessonPlan = z.infer<typeof LessonPlanSchema>;

/**
 * The model is asked to produce everything EXCEPT citation grounding status,
 * which the server computes. This omit keeps the model's contract honest.
 */
export const GeneratedLessonPlanSchema = LessonPlanSchema.extend({
  citations: z.array(CitationSchema.omit({ groundingStatus: true })),
});

// -- the full API response --------------------------------------------------

export interface RetrievalProvenance {
  sourceId: string;
  title: string;
  score: number;
  translationStatus: string;
  query: string;
}

export interface PlannerResult {
  plan: LessonPlan;
  provenance: RetrievalProvenance[];
  warnings: string[];
  credits: { spent: number; poolBalance: number | null };
}
