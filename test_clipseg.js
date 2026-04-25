import { AutoProcessor, AutoTokenizer, AutoModelForImageSegmentation, RawImage, env } from '@huggingface/transformers';

env.allowLocalModels = false;

async function test() {
  const processor = await AutoProcessor.from_pretrained('Xenova/clipseg-rd64-refined');
  const tokenizer = await AutoTokenizer.from_pretrained('Xenova/clipseg-rd64-refined');
  const model = await AutoModelForImageSegmentation.from_pretrained('Xenova/clipseg-rd64-refined');

  const img = await RawImage.read('https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png');
  const texts = ['dice'];
  const textInputs = await tokenizer(texts, { padding: true, truncation: true });
  const imageInputs = await processor(img);

  const inputs = { ...textInputs, ...imageInputs };

  const { logits } = await model(inputs);
  
  // Apply sigmoid
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const data = new Float32Array(logits.data.length);
  let max = -500;
  for (let i = 0; i < logits.data.length; i++) {
     data[i] = sigmoid(logits.data[i]);
     if (data[i] > max) max = data[i];
  }
  console.log('max val', max);

}
test();

