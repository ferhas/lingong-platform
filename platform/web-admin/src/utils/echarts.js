// echarts 按需装配模块：仅注册运营总览用到的图表/组件，配合动态 import 实现「tree-shake + 懒加载」
// 静态命名导入在此被 Rollup 摇树，动态 import('../utils/echarts') 将其打成独立 async chunk
import * as echarts from 'echarts/core'
import { LineChart, PieChart, BarChart } from 'echarts/charts'
import { TooltipComponent, GridComponent, LegendComponent, TitleComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([LineChart, PieChart, BarChart, TooltipComponent, GridComponent, LegendComponent, TitleComponent, CanvasRenderer])

export default echarts
