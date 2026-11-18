// 评分标准预设。每项：name 维度名称，max 满分，desc 评分要点。用户可在页面上修改。

export const RUBRICS = {
  zhongkao: {
    label: '中考作文（50分）',
    items: [
      { name: '内容', max: 20, desc: '切合题意，中心明确，内容充实，感情真挚，选材典型新颖' },
      { name: '语言', max: 15, desc: '语言通顺、准确、生动，句式灵活，无明显语病' },
      { name: '结构', max: 10, desc: '结构完整，层次清晰，详略得当，过渡自然，首尾呼应' },
      { name: '书写与规范', max: 5, desc: '标点正确，错别字少（每3个错别字扣1分，重复不计），字数达标' },
    ],
  },
  gaokao: {
    label: '高考作文（60分）',
    items: [
      { name: '内容（基础等级）', max: 20, desc: '符合题意，中心突出，内容充实，思想健康，感情真挚' },
      { name: '表达（基础等级）', max: 20, desc: '符合文体要求，结构严谨，语言流畅，字迹工整' },
      { name: '发展等级', max: 20, desc: '深刻、丰富、有文采、有创意，四项中突出一项即可给高分' },
    ],
  },
  primary: {
    label: '小学作文（30分）',
    items: [
      { name: '内容', max: 10, desc: '围绕题目写，内容具体，有真情实感' },
      { name: '语言', max: 10, desc: '语句通顺，用词恰当，能用上好词好句和修辞' },
      { name: '结构', max: 6, desc: '条理清楚，分段合理，开头结尾完整' },
      { name: '标点与书写', max: 4, desc: '标点正确，错别字少' },
    ],
  },
  hundred: {
    label: '通用百分制（100分）',
    items: [
      { name: '立意', max: 25, desc: '立意正确、鲜明、有深度' },
      { name: '内容', max: 25, desc: '材料充实、真实、典型，能支撑中心' },
      { name: '结构', max: 20, desc: '层次清楚，衔接自然，详略得当' },
      { name: '语言', max: 30, desc: '准确流畅，生动有文采，无语病和错别字' },
    ],
  },
};

export const DEFAULT_RUBRIC = 'zhongkao';

export function cloneItems(key) {
  return RUBRICS[key].items.map((i) => ({ ...i }));
}
