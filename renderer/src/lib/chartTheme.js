// ECharts 主题(终末地风格:暗色 + 荧光青/琥珀橙)。
// 主窗口恒为暗色(body.dark),isDark 参数保留兼容,实际始终按暗色渲染。
export function getTheme(isDark) {
  const dark = true;
  return {
    color: ['#7CE7FF', '#4ADE80', '#FFB03A', '#FF5C5C', '#A9F1FF', '#B48BFF'],
    backgroundColor: 'transparent',
    textStyle: {
      fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: 10,
      color: '#8494A3'
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
        color: '#8494A3',
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
        color: '#8494A3',
        formatter: function (v) {
          if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
          if (v >= 1000) return (v / 1000).toFixed(0) + 'K';
          return v.toString();
        }
      },
      splitLine: {
        lineStyle: {
          color: 'rgba(124, 231, 255, 0.08)',
          type: 'dashed'
        }
      }
    },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      confine: false,
      backgroundColor: 'rgba(10, 14, 18, 0.96)',
      borderColor: 'rgba(124, 231, 255, 0.3)',
      textStyle: {
        color: '#E2ECF2',
        fontSize: 11
      }
    }
  };
}

export function getBarTheme(isDark) {
  return {
    textColor: '#8494A3',
    gridColor: 'rgba(124, 231, 255, 0.08)',
    axisLineColor: '#22313D'
  };
}
