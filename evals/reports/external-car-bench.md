# CAR-bench External Benchmark

- Commit: `54990894241f2c07e9b523928c2a29e9b693d313`
- Result: CAR-bench Full Test
- Coverage: 125/125
- Overall Pass@1: 38.40%

| Split          | Tasks | Pass@1 | Tool errors | Policy errors | Unsupported / hallucinated failures |
| -------------- | ----: | -----: | ----------: | ------------: | ----------------------------------: |
| base           |    50 | 56.00% |           0 |             6 |                                   0 |
| hallucination  |    50 | 14.00% |          27 |             0 |                                  43 |
| disambiguation |    25 | 52.00% |           0 |             4 |                                   0 |

77 个未通过任务中，26 个是无基础设施异常的官方 reward=0，24 个是 120 秒 planning bridge 超时，27 个是官方 LLM user simulator 在空输出后触发的 `UnboundLocalError`。三类均保留并按官方 evaluator 计为失败。
