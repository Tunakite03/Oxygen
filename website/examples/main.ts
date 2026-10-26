import { getLanguage, onLanguageChange, requireElement } from '../shared/site';

type Category = 'all' | 'rendering' | 'simulation' | 'interaction';
const filters = document.querySelectorAll<HTMLButtonElement>('[data-category]');
const examples = document.querySelectorAll<HTMLElement>('[data-example-category]');
const count = requireElement('example-count');
let selected: Category = 'all';

function renderExamples(): void {
  let visible = 0;
  for (const example of examples) {
    example.hidden = selected !== 'all' && example.dataset.exampleCategory !== selected;
    if (!example.hidden) visible += 1;
  }
  for (const button of filters) button.setAttribute('aria-pressed', String(button.dataset.category === selected));
  count.textContent = getLanguage() === 'vi' ? `${visible} ví dụ` : `${visible} examples`;
}

for (const button of filters) {
  button.addEventListener('click', () => {
    const category = button.dataset.category;
    if (category !== 'all' && category !== 'rendering' && category !== 'simulation' && category !== 'interaction') {
      throw new RangeError('Unsupported example category');
    }
    selected = category;
    renderExamples();
  });
}
onLanguageChange(renderExamples);
