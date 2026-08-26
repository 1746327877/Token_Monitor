// ECharts 主题(终末地风格:近黑底 + 荧光黄/绿/粉)。
// 主窗口恒为暗色(body.dark),isDark 参数保留兼容,实际始终按暗色渲染。
export function getTheme(isDark) {
  const dark = true;
  return {
    color: ['#fffa00', '#00ffa2', '#ff1aac', '#5c8dff', '#fffa00', '#e5e5e5'],
    backgroundColor: 'transparent',
    textStyle: {
      fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: 10,
      color: '#9a9a9a'
    },
    grid: {
      top: 12,
      right: 12,
      bottom: 28,
      left: 52,
      containLabel: false
    },
    xAxis: {
      type: 'category',
      data: [],
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 9,
        color: '#9a9a9a',
        interval: 'auto'
      },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 9,
        color: '#9a9a9a',
        formatter: function (v) {
          if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
          if (v >= 1000) return (v / 1000).toFixed(0) + 'K';
          return v.toString();
        }
      },
      splitLine: {
        lineStyle: {
          color: 'rgba(255, 250, 0, 0.08)',
          type: 'dashed'
        }
      }
    },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      confine: false,
      backgroundColor: 'rgba(15, 15, 17, 0.96)',
      borderColor: 'rgba(255, 250, 0, 0.35)',
      textStyle: {
        color: '#e5e5e5',
        fontSize: 11
      }
    }
  };
}

export function getBarTheme(isDark) {
  return {
    textColor: '#9a9a9a',
    gridColor: 'rgba(255, 250, 0, 0.08)',
    axisLineColor: '#35373c'
  };
}
