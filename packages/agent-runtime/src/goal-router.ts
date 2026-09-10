import type { FormalToolName, ToolDefinition } from "@driveguard/tools";

export type GoalIntentClass = "NO_TOOL" | "READ" | "WRITE" | "MIXED" | "AMBIGUOUS";

export interface GoalToolPlan {
  readonly intentClass: GoalIntentClass;
  readonly candidateToolNames: readonly FormalToolName[];
  readonly stopCondition:
    | "RESPOND_WITHOUT_TOOL"
    | "CAPABILITY_UNAVAILABLE"
    | "REQUIRED_GOALS_SATISFIED"
    | "MODEL_DECIDES";
}

interface RoutingRule {
  readonly toolName: FormalToolName;
  readonly operation: "READ" | "WRITE";
  readonly matches: (prompt: string) => boolean;
}

const includes = (prompt: string, pattern: RegExp): boolean => pattern.test(prompt);

const ROUTING_RULES: readonly RoutingRule[] = Object.freeze([
  {
    toolName: "reroute_to_charger",
    operation: "WRITE",
    matches: (prompt) =>
      includes(
        prompt,
        /(?:路线.*改到.*充电站|导航去.*充电站|充电点设为新目的地|改道.*充电站|带我去.*充电站|电量.*非常低.*安全处理)/iu,
      ),
  },
  {
    toolName: "reserve_charging_slot",
    operation: "WRITE",
    matches: (prompt) =>
      includes(prompt, /(?:预订|预约|订个位|留一个位置|安排.*预约|安排去.*充电站充电)/iu),
  },
  {
    toolName: "cancel_charging_reservation",
    operation: "WRITE",
    matches: (prompt) => includes(prompt, /(?:取消|撤销).*(?:充电|预约|预订)/iu),
  },
  {
    toolName: "request_roadside_assistance",
    operation: "WRITE",
    matches: (prompt) => includes(prompt, /(?:道路救援|轮胎.*(?:爆|瘪)|车辆报告故障|roadside)/iu),
  },
  {
    toolName: "request_emergency_support",
    operation: "WRITE",
    matches: (prompt) => includes(prompt, /(?:紧急协助|紧急援助|emergency support)/iu),
  },
  {
    toolName: "set_cabin_temperature",
    operation: "WRITE",
    matches: (prompt) =>
      includes(prompt, /(?:车内|座舱|cabin).*(?:温度|temperature).*(?:调|设|set)/iu),
  },
  {
    toolName: "set_seat_heating",
    operation: "WRITE",
    matches: (prompt) => includes(prompt, /(?:座椅加热|seat heat).*(?:调|设|档|level)/iu),
  },
  {
    toolName: "set_media_volume",
    operation: "WRITE",
    matches: (prompt) => includes(prompt, /(?:媒体音量|音量|media volume).*(?:调|设|到|set)/iu),
  },
  {
    toolName: "set_navigation_destination",
    operation: "WRITE",
    matches: (prompt) =>
      !includes(prompt, /(?:充电站|充电点)/iu) &&
      includes(
        prompt,
        /(?:导航去|带我去|路线改到|导航目的地(?:设置|改)|设为新目的地|set.*(?:navigation )?destination)/iu,
      ),
  },
  {
    toolName: "search_charging_stations",
    operation: "READ",
    matches: (prompt) =>
      includes(
        prompt,
        /(?:(?:找|查|看看).*(?:附近|周边|沿途).*(?:充电站|充电点)|附近哪里可以充电|search.*charg)/iu,
      ),
  },
  {
    toolName: "get_charging_status",
    operation: "READ",
    matches: (prompt) =>
      includes(
        prompt,
        /(?:充电状态|充电进度|有没有在充电|充上电了吗|是否正在充电|charging status)/iu,
      ),
  },
  {
    toolName: "get_weather",
    operation: "READ",
    matches: (prompt) => includes(prompt, /(?:天气|weather)/iu),
  },
  {
    toolName: "get_trip_state",
    operation: "READ",
    matches: (prompt) =>
      includes(
        prompt,
        /(?:(?:查看|告诉|看看).*(?:当前路线|导航路线)|导航目的地和剩余时间|当前目的地和行程|导航到哪里|当前导航状态|导航信息.*(?:目的地|变化)|current (?:trip|route)|remaining trip)/iu,
      ),
  },
  {
    toolName: "get_vehicle_state",
    operation: "READ",
    matches: (prompt) =>
      includes(
        prompt,
        /(?:告诉我.*(?:电量|车速)|看看.*(?:剩余电量|车辆状态)|查看.*(?:电量|车速)|电量是多少|仪表显示.*(?:电量|车速)|查一下.*(?:电量|速度)|还剩多少电|读取.*(?:电量|行驶速度)|battery|vehicle state|speed)/iu,
      ),
  },
]);

const EXPLICIT_NO_TOOL =
  /(?:向我问好|说明你能做什么|解释为什么安全操作需要确认|简短驾驶提示|踩下刹车|控制方向盘|油门|关闭AEB|关闭ESC)/iu;

export class GoalToolRouter {
  plan(prompt: string, available: readonly ToolDefinition[]): GoalToolPlan {
    const allowed = new Set(available.map((definition) => definition.name));
    const intentMatched = ROUTING_RULES.filter((rule) => rule.matches(prompt));
    const matched = intentMatched.filter((rule) => allowed.has(rule.toolName));
    const names = Object.freeze([...new Set(matched.map((rule) => rule.toolName))]);
    if (intentMatched.length === 0) {
      const noTool = EXPLICIT_NO_TOOL.test(prompt);
      return Object.freeze({
        intentClass: noTool ? "NO_TOOL" : "AMBIGUOUS",
        candidateToolNames: Object.freeze(
          noTool ? [] : available.map((definition) => definition.name as FormalToolName),
        ),
        stopCondition: noTool ? "RESPOND_WITHOUT_TOOL" : "MODEL_DECIDES",
      });
    }
    const operations = new Set(intentMatched.map((rule) => rule.operation));
    return Object.freeze({
      intentClass: operations.size > 1 ? "MIXED" : operations.has("WRITE") ? "WRITE" : "READ",
      candidateToolNames: names,
      stopCondition: names.length === 0 ? "CAPABILITY_UNAVAILABLE" : "REQUIRED_GOALS_SATISFIED",
    });
  }
}

export function renderGoalBoundPrompt(plan: GoalToolPlan, userPrompt: string): string {
  if (plan.intentClass === "AMBIGUOUS") return userPrompt;
  const contract =
    plan.intentClass === "NO_TOOL"
      ? "Respond directly without calling a tool."
      : plan.stopCondition === "CAPABILITY_UNAVAILABLE"
        ? "The requested capability is unavailable in the current runtime mode. Respond without calling another tool and do not claim success."
        : `You MUST call every tool in this trusted shortlist exactly once: ${plan.candidateToolNames.join(", ")}. The user's values are sufficient after runtime canonicalization; do not ask for missing details. Never retry or duplicate a tool call. If any tool returns an error, policy control, or confirmation requirement, stop calling tools immediately. For R2/R3, call the tool to create the formal confirmation instead of asking orally. In the final response, report only the observed outcome or receipt; do not ask for confirmation orally or offer additional operations.`;
  return `[Trusted DriveGuard goal contract]\n${contract}\n[User request]\n${userPrompt}`;
}
