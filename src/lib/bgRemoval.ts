import { AutoModel, AutoProcessor, AutoTokenizer, AutoModelForImageSegmentation, RawImage, env, Tensor } from '@huggingface/transformers';

env.allowLocalModels = false;
env.backends.onnx.wasm.proxy = true;

const MODEL_ID = 'briaai/RMBG-1.4';
const CLIPSEG_ID = 'Xenova/clipseg-rd64-refined';

let rmbgModelPromise: Promise<any> | null = null;
let rmbgProcessorPromise: Promise<any> | null = null;

let clipsegModelPromise: Promise<any> | null = null;
let clipsegProcessorPromise: Promise<any> | null = null;
let clipsegTokenizerPromise: Promise<any> | null = null;

function loadModels(useClipseg: boolean) {
  if (!rmbgModelPromise) {
    rmbgModelPromise = AutoModel.from_pretrained(MODEL_ID, { config: { model_type: 'custom' } as any });
  }
  if (!rmbgProcessorPromise) {
    rmbgProcessorPromise = AutoProcessor.from_pretrained(MODEL_ID, { config: { model_type: 'custom' } as any });
  }
  if (useClipseg) {
    if (!clipsegModelPromise) {
      clipsegModelPromise = AutoModelForImageSegmentation.from_pretrained(CLIPSEG_ID);
    }
    if (!clipsegProcessorPromise) {
      clipsegProcessorPromise = AutoProcessor.from_pretrained(CLIPSEG_ID);
    }
    if (!clipsegTokenizerPromise) {
      clipsegTokenizerPromise = AutoTokenizer.from_pretrained(CLIPSEG_ID);
    }
  }
}

async function getClipsegMask(img: any, prompt: string): Promise<Uint8Array> {
  const [model, processor, tokenizer] = await Promise.all([clipsegModelPromise, clipsegProcessorPromise, clipsegTokenizerPromise]);
  const textInputs = await tokenizer([prompt], { padding: true, truncation: true });
  const imageInputs = await processor(img);
  const inputs = { ...textInputs, ...imageInputs };
  const { logits } = await model(inputs);
  
  // Apply sigmoid and convert to uint8
  const out = new Uint8Array(logits.data.length);
  for (let i = 0; i < logits.data.length; i++) {
     const val = 1 / (1 + Math.exp(-logits.data[i]));
     out[i] = Math.round(val * 255);
  }
  
  // logits.dims is usually [352, 352]
  let tensorDims = logits.dims;
  if (tensorDims.length === 2) {
      tensorDims = [1, tensorDims[0], tensorDims[1]];
  } else if (tensorDims.length === 4) {
      // e.g. [1, 1, 352, 352] -> drop batch
      tensorDims = [tensorDims[1], tensorDims[2], tensorDims[3]];
  }
  const tensor = new Tensor('uint8', out, tensorDims);
  
  const maskImg = await RawImage.fromTensor(tensor).resize(img.width, img.height);
  return new Uint8Array(maskImg.data); // Uint8Array
}

export async function removeBackgroundV2(
  imageUrl: string, 
  alphaOffset: number = 0,
  keepPrompt: string = '',
  removePrompt: string = ''
): Promise<Blob> {
  const useClipseg = keepPrompt.trim() !== '' || removePrompt.trim() !== '';
  loadModels(useClipseg);
  
  const [rmbgModel, rmbgProcessor] = await Promise.all([rmbgModelPromise, rmbgProcessorPromise]);
  
  // Read image
  const img = await RawImage.fromURL(imageUrl);
  
  // Run RMBG
  const { pixel_values } = await rmbgProcessor(img);
  const { output } = await rmbgModel({ input: pixel_values });
  
  const maskData = output.mul(255).to('uint8');
  maskData.dims = [1, maskData.dims[2], maskData.dims[3]];
  
  // Apply AI Sensitivity (gamma curve)
  if (alphaOffset !== 0) {
    // gamma ranges from e.g. 0.1 to 10
    // alphaOffset = 100 -> gamma = 0.2 (keeps more, makes values approach 1)
    // alphaOffset = -100 -> gamma = 5 (keeps less, pushes values towards 0)
    const gamma = Math.pow(10, -alphaOffset / 100); 

    for (let i = 0; i < maskData.data.length; i++) {
        let val = maskData.data[i] / 255.0;
        val = Math.pow(val, gamma);
        maskData.data[i] = Math.round(val * 255);
    }
  }

  const mask = await RawImage.fromTensor(maskData).resize(img.width, img.height);
  
  // Apply Keep/Remove logic if useClipseg
  let keepRaw = null;
  let removeRaw = null;
  if (useClipseg && keepPrompt.trim() !== '') {
    keepRaw = await getClipsegMask(img, keepPrompt.trim());
  }
  if (useClipseg && removePrompt.trim() !== '') {
    removeRaw = await getClipsegMask(img, removePrompt.trim());
  }
  
  // modify mask.data (Uint8Array)
  for (let i = 0; i < mask.data.length; i++) {
      if (keepRaw) {
          // keepRaw[i] is 0..1 (maybe 0..255 if fromTensor auto casted, actually RawImage.resize on float32 might return uint8 or float32. Let's assume 0..255 if uint8, 0..1 if float32)
          let keepVal = keepRaw[i];
          if (keepRaw.constructor.name === 'Float32Array') keepVal = keepVal * 255;
          if (keepVal > 50) mask.data[i] = Math.max(mask.data[i], keepVal);
      }
      if (removeRaw) {
          let removeVal = removeRaw[i];
          if (removeRaw.constructor.name === 'Float32Array') removeVal = removeVal * 255;
          if (removeVal > 100) mask.data[i] = 0;
      }
  }
  
  // Apply mask to original image on a canvas
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  
  if (!ctx) throw new Error('Could not get canvas context');
  
  const htmlImg = new Image();
  htmlImg.src = imageUrl;
  await new Promise((resolve, reject) => {
    htmlImg.onload = resolve;
    htmlImg.onerror = reject;
  });
  
  ctx.drawImage(htmlImg, 0, 0);
  
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  for (let i = 0; i < mask.data.length; i++) {
    imageData.data[i * 4 + 3] = mask.data[i];
  }
  ctx.putImageData(imageData, 0, 0);
  
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b); else reject(new Error('Failed to create blob'));
    }, 'image/png');
  });
}
