const feed = (id, name, feedUrl, homepage, options = {}) => ({
  id,
  name,
  feedUrl,
  homepage,
  connector: 'feed',
  kind: options.kind ?? 'news',
  channel: options.channel ?? 'media',
  tier: options.tier ?? 2,
  topics: options.topics ?? ['ai'],
  language: options.language ?? 'en',
  enabled: options.enabled ?? true,
  pollMinutes: options.pollMinutes ?? 180,
  allowArticleFetch: options.allowArticleFetch ?? true,
  allowEmpty: options.allowEmpty ?? false,
  aiEligible: options.aiEligible ?? true,
  forceDisabled: options.forceDisabled ?? false,
  disabledReason: options.disabledReason ?? null,
  builtIn: true
});

const release = (id, name, repository, options = {}) => ({
  id,
  name,
  repository,
  feedUrl: `https://api.github.com/repos/${repository}/releases?per_page=10`,
  homepage: `https://github.com/${repository}/releases`,
  connector: 'github-releases',
  kind: 'first-party',
  channel: 'release',
  tier: options.tier ?? 1,
  topics: options.topics ?? ['developer-tools', 'open-source'],
  language: 'en',
  enabled: true,
  pollMinutes: options.pollMinutes ?? 360,
  allowArticleFetch: false,
  allowEmpty: true,
  aiEligible: true,
  builtIn: true
});

const social = (id, name, connector, identity, options = {}) => ({
  id,
  name,
  connector,
  ...(connector === 'x-user' ? { xUsername: identity } : { subreddit: identity }),
  homepage: connector === 'x-user' ? `https://x.com/${identity}` : `https://www.reddit.com/r/${identity}/`,
  kind: 'social',
  channel: connector === 'x-user' ? 'social' : 'community',
  tier: options.tier ?? 3,
  topics: options.topics ?? ['ai'],
  language: options.language ?? 'en',
  author: options.author ?? name,
  enabled: false,
  pollMinutes: options.pollMinutes ?? 120,
  allowArticleFetch: false,
  aiEligible: false,
  setupRequired: connector === 'x-user' ? 'X_BEARER_TOKEN' : 'REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET',
  builtIn: true
});

const coreFeeds = [
  feed('openai-news', 'OpenAI News', 'https://openai.com/news/rss.xml', 'https://openai.com/news/', { kind: 'first-party', channel: 'official', tier: 1, topics: ['models', 'products', 'safety'], pollMinutes: 30 }),
  feed('google-ai-blog', 'Google Blog - AI', 'https://blog.google/technology/ai/rss/', 'https://blog.google/innovation-and-ai/technology/ai/', { kind: 'first-party', channel: 'official', tier: 1, topics: ['models', 'products'], pollMinutes: 60 }),
  feed('huggingface-blog', 'Hugging Face Blog', 'https://huggingface.co/blog/feed.xml', 'https://huggingface.co/blog', { kind: 'first-party', channel: 'official', tier: 1, topics: ['open-source', 'models', 'research'], pollMinutes: 90 }),
  feed('aws-machine-learning', 'AWS Machine Learning Blog', 'https://aws.amazon.com/blogs/machine-learning/feed/', 'https://aws.amazon.com/blogs/machine-learning/', { channel: 'official', tier: 1, topics: ['cloud', 'engineering'], pollMinutes: 120 }),
  feed('google-research', 'Google Research Blog', 'https://research.google/blog/rss/', 'https://research.google/blog/', { kind: 'first-party', channel: 'research', tier: 1, topics: ['research', 'papers'], pollMinutes: 180 }),
  feed('github-machine-learning', 'GitHub Blog - Machine Learning', 'https://github.blog/ai-and-ml/machine-learning/feed/', 'https://github.blog/ai-and-ml/machine-learning/', { channel: 'official', tier: 1, topics: ['developer-tools', 'engineering'], pollMinutes: 180 }),
  feed('nvidia-deep-learning', 'NVIDIA Deep Learning Blog', 'https://blogs.nvidia.com/blog/category/deep-learning/feed/', 'https://blogs.nvidia.com/blog/category/deep-learning/', { channel: 'official', tier: 1, topics: ['infrastructure', 'models'], pollMinutes: 180 }),
  feed('cloudflare-ai', 'Cloudflare Blog - AI', 'https://blog.cloudflare.com/tag/ai/rss/', 'https://blog.cloudflare.com/tag/ai/', { channel: 'official', tier: 1, topics: ['infrastructure', 'edge'], pollMinutes: 180 }),
  feed('microsoft-research', 'Microsoft Research Blog', 'https://www.microsoft.com/en-us/research/feed/', 'https://www.microsoft.com/en-us/research/blog/', { kind: 'first-party', channel: 'research', tier: 1, topics: ['research', 'papers'], pollMinutes: 240 }),
  feed('apple-ml-research', 'Apple Machine Learning Research', 'https://machinelearning.apple.com/rss.xml', 'https://machinelearning.apple.com/', { kind: 'first-party', channel: 'research', tier: 1, topics: ['research', 'on-device'], pollMinutes: 240 })
];

const releases = [
  ['openai-python-releases', 'OpenAI Python Releases', 'openai/openai-python', ['sdk']],
  ['transformers-releases', 'Transformers Releases', 'huggingface/transformers', ['models', 'open-source']],
  ['vllm-releases', 'vLLM Releases', 'vllm-project/vllm', ['inference']],
  ['ollama-releases', 'Ollama Releases', 'ollama/ollama', ['local-ai']],
  ['autogen-releases', 'Microsoft AutoGen Releases', 'microsoft/autogen', ['agents']],
  ['semantic-kernel-releases', 'Microsoft Semantic Kernel Releases', 'microsoft/semantic-kernel', ['agents']],
  ['langchain-releases', 'LangChain Releases', 'langchain-ai/langchain', ['agents']],
  ['dify-releases', 'Dify Releases', 'langgenius/dify', ['agents', 'platform']],
  ['litellm-releases', 'LiteLLM Releases', 'BerriAI/litellm', ['inference', 'gateway']],
  ['pydantic-ai-releases', 'Pydantic AI Releases', 'pydantic/pydantic-ai', ['agents']],
  ['markitdown-releases', 'Microsoft MarkItDown Releases', 'microsoft/markitdown', ['documents']],
  ['deepspeed-releases', 'DeepSpeed Releases', 'deepspeedai/DeepSpeed', ['training']],
  ['tensorrt-llm-releases', 'NVIDIA TensorRT-LLM Releases', 'NVIDIA/TensorRT-LLM', ['inference']],
  ['nemo-speech-releases', 'NVIDIA NeMo Speech Releases', 'NVIDIA-NeMo/Speech', ['audio']],
  ['sglang-releases', 'SGLang Releases', 'sgl-project/sglang', ['inference']],
  ['llamaindex-releases', 'LlamaIndex Releases', 'run-llama/llama_index', ['rag', 'agents']],
  ['haystack-releases', 'Haystack Releases', 'deepset-ai/haystack', ['rag', 'agents']],
  ['dspy-releases', 'DSPy Releases', 'stanfordnlp/dspy', ['agents', 'research']],
  ['aider-releases', 'Aider Releases', 'Aider-AI/aider', ['coding']],
  ['openhands-releases', 'OpenHands Releases', 'OpenHands/OpenHands', ['coding', 'agents']],
  ['continue-releases', 'Continue Releases', 'continuedev/continue', ['coding']],
  ['cline-releases', 'Cline Releases', 'cline/cline', ['coding']],
  ['goose-releases', 'Goose Releases', 'block/goose', ['coding', 'agents']],
  ['mem0-releases', 'Mem0 Releases', 'mem0ai/mem0', ['memory', 'agents']],
  ['browser-use-releases', 'Browser Use Releases', 'browser-use/browser-use', ['agents', 'browser']],
  ['composio-releases', 'Composio Releases', 'ComposioHQ/composio', ['agents', 'tools']],
  ['agent-framework-releases', 'Microsoft Agent Framework Releases', 'microsoft/agent-framework', ['agents']],
  ['langflow-releases', 'Langflow Releases', 'langflow-ai/langflow', ['agents', 'platform']],
  ['openai-agents-python-releases', 'OpenAI Agents Python Releases', 'openai/openai-agents-python', ['agents', 'sdk']],
  ['anthropic-python-releases', 'Anthropic Python SDK Releases', 'anthropics/anthropic-sdk-python', ['sdk']],
  ['pytorch-releases', 'PyTorch Releases', 'pytorch/pytorch', ['training']],
  ['tensorflow-releases', 'TensorFlow Releases', 'tensorflow/tensorflow', ['training']],
  ['jax-releases', 'JAX Releases', 'jax-ml/jax', ['training']],
  ['mlx-releases', 'Apple MLX Releases', 'ml-explore/mlx', ['on-device']],
  ['llama-cpp-releases', 'llama.cpp Releases', 'ggml-org/llama.cpp', ['local-ai', 'inference']],
  ['diffusers-releases', 'Diffusers Releases', 'huggingface/diffusers', ['image', 'models']],
  ['accelerate-releases', 'Accelerate Releases', 'huggingface/accelerate', ['training']],
  ['gradio-releases', 'Gradio Releases', 'gradio-app/gradio', ['platform']],
  ['ray-releases', 'Ray Releases', 'ray-project/ray', ['infrastructure']],
  ['kubeflow-releases', 'Kubeflow Releases', 'kubeflow/kubeflow', ['infrastructure']],
  ['crewai-releases', 'CrewAI Releases', 'crewAIInc/crewAI', ['agents']],
  ['autogpt-releases', 'AutoGPT Releases', 'Significant-Gravitas/AutoGPT', ['agents']],
  ['n8n-releases', 'n8n Releases', 'n8n-io/n8n', ['automation', 'agents']],
  ['flowise-releases', 'Flowise Releases', 'FlowiseAI/Flowise', ['agents', 'platform']],
  ['qdrant-releases', 'Qdrant Releases', 'qdrant/qdrant', ['vector-database']],
  ['weaviate-releases', 'Weaviate Releases', 'weaviate/weaviate', ['vector-database']],
  ['milvus-releases', 'Milvus Releases', 'milvus-io/milvus', ['vector-database']],
  ['chroma-releases', 'Chroma Releases', 'chroma-core/chroma', ['vector-database']],
  ['guidance-releases', 'Guidance Releases', 'guidance-ai/guidance', ['agents', 'structured-output']],
  ['outlines-releases', 'Outlines Releases', 'dottxt-ai/outlines', ['structured-output']],
  ['codex-releases', 'OpenAI Codex Releases', 'openai/codex', ['coding', 'agents']],
  ['claude-code-releases', 'Claude Code Releases', 'anthropics/claude-code', ['coding', 'agents']],
  ['gemini-cli-releases', 'Gemini CLI Releases', 'google-gemini/gemini-cli', ['coding', 'agents']],
  ['onnxruntime-releases', 'ONNX Runtime Releases', 'microsoft/onnxruntime', ['inference']],
  ['open-webui-releases', 'Open WebUI Releases', 'open-webui/open-webui', ['local-ai', 'platform']],
  ['whisper-cpp-releases', 'whisper.cpp Releases', 'ggml-org/whisper.cpp', ['audio', 'local-ai']]
].map(([id, name, repository, topics]) => release(id, name, repository, { topics }));

const industryFeeds = [
  feed('google-deepmind', 'Google DeepMind Blog', 'https://deepmind.google/blog/rss.xml', 'https://deepmind.google/blog/', { kind: 'first-party', channel: 'research', tier: 1, topics: ['research', 'models'], pollMinutes: 120 }),
  feed('meta-ai', 'Meta AI Blog', 'https://ai.meta.com/blog/rss/', 'https://ai.meta.com/blog/', { kind: 'first-party', channel: 'research', tier: 1, topics: ['research', 'open-source'], pollMinutes: 180 }),
  feed('microsoft-ai', 'Microsoft AI Blog', 'https://news.microsoft.com/source/tag/ai/feed/', 'https://news.microsoft.com/source/tag/ai/', { kind: 'first-party', channel: 'official', tier: 1, topics: ['products', 'enterprise'], pollMinutes: 180 }),
  feed('nvidia-developer-genai', 'NVIDIA Developer - Generative AI', 'https://developer.nvidia.com/blog/category/generative-ai/feed/', 'https://developer.nvidia.com/blog/tag/generative-ai/', { kind: 'first-party', channel: 'official', tier: 1, topics: ['infrastructure', 'engineering'], pollMinutes: 180 }),
  feed('databricks-ai', 'Databricks AI Blog', 'https://www.databricks.com/blog/category/engineering/artificial-intelligence/feed', 'https://www.databricks.com/blog/category/engineering/artificial-intelligence', { kind: 'first-party', channel: 'official', tier: 1, topics: ['data', 'enterprise'], pollMinutes: 240, enabled: false, forceDisabled: true, disabledReason: '上游已停止提供可解析 RSS' }),
  feed('cohere-blog', 'Cohere Blog', 'https://cohere.com/blog/rss.xml', 'https://cohere.com/blog', { kind: 'first-party', channel: 'official', tier: 1, topics: ['models', 'enterprise'], pollMinutes: 240, enabled: false, forceDisabled: true, disabledReason: '上游地址当前返回网页而非 RSS' }),
  feed('mistral-news', 'Mistral AI News', 'https://mistral.ai/news/rss.xml', 'https://mistral.ai/news/', { kind: 'first-party', channel: 'official', tier: 1, topics: ['models', 'open-source'], pollMinutes: 180 }),
  feed('stability-news', 'Stability AI News', 'https://stability.ai/news/rss.xml', 'https://stability.ai/news', { kind: 'first-party', channel: 'official', tier: 1, topics: ['image', 'models'], pollMinutes: 240, enabled: false, forceDisabled: true, disabledReason: '上游地址当前返回网页而非 RSS' }),
  feed('together-blog', 'Together AI Blog', 'https://www.together.ai/blog/rss.xml', 'https://www.together.ai/blog', { kind: 'first-party', channel: 'official', tier: 1, topics: ['inference', 'models'], pollMinutes: 240 }),
  feed('wandb-fully-connected', 'Weights & Biases - Fully Connected', 'https://wandb.ai/fully-connected/rss.xml', 'https://wandb.ai/fully-connected', { kind: 'first-party', channel: 'blog', tier: 2, topics: ['engineering', 'mlops'], pollMinutes: 240 }),
  feed('replicate-blog', 'Replicate Blog', 'https://replicate.com/blog/rss', 'https://replicate.com/blog', { kind: 'first-party', channel: 'blog', tier: 2, topics: ['inference', 'models'], pollMinutes: 240 }),
  feed('modal-blog', 'Modal Blog', 'https://modal.com/blog/rss.xml', 'https://modal.com/blog', { kind: 'first-party', channel: 'blog', tier: 2, topics: ['infrastructure', 'engineering'], pollMinutes: 240, enabled: false, forceDisabled: true, disabledReason: '上游地址已失效' }),
  feed('baseten-blog', 'Baseten Blog', 'https://www.baseten.co/blog/rss.xml', 'https://www.baseten.co/blog', { kind: 'first-party', channel: 'blog', tier: 2, topics: ['inference', 'engineering'], pollMinutes: 240, enabled: false, forceDisabled: true, disabledReason: '上游地址已失效' }),
  feed('assemblyai-blog', 'AssemblyAI Blog', 'https://www.assemblyai.com/blog/rss/', 'https://www.assemblyai.com/blog', { kind: 'first-party', channel: 'blog', tier: 2, topics: ['audio', 'engineering'], pollMinutes: 240, enabled: false, forceDisabled: true, disabledReason: '上游地址已失效' }),
  feed('deepgram-blog', 'Deepgram Blog', 'https://deepgram.com/learn/rss.xml', 'https://deepgram.com/learn', { kind: 'first-party', channel: 'blog', tier: 2, topics: ['audio', 'engineering'], pollMinutes: 240, enabled: false, forceDisabled: true, disabledReason: '上游地址已失效' }),
  feed('pinecone-blog', 'Pinecone Blog', 'https://www.pinecone.io/blog/rss/', 'https://www.pinecone.io/blog/', { kind: 'first-party', channel: 'blog', tier: 2, topics: ['rag', 'vector-database'], pollMinutes: 240, enabled: false, forceDisabled: true, disabledReason: '上游地址已失效' }),
  feed('qdrant-blog', 'Qdrant Blog', 'https://qdrant.tech/blog/index.xml', 'https://qdrant.tech/blog/', { kind: 'first-party', channel: 'blog', tier: 2, topics: ['rag', 'vector-database'], pollMinutes: 240 }),
  feed('weaviate-blog', 'Weaviate Blog', 'https://weaviate.io/blog/rss.xml', 'https://weaviate.io/blog', { kind: 'first-party', channel: 'blog', tier: 2, topics: ['rag', 'vector-database'], pollMinutes: 240 }),
  feed('stanford-hai', 'Stanford HAI News', 'https://hai.stanford.edu/news/rss.xml', 'https://hai.stanford.edu/news', { channel: 'research', tier: 1, topics: ['research', 'policy'], pollMinutes: 240, enabled: false, forceDisabled: true, disabledReason: '上游地址当前返回网页而非 RSS' }),
  feed('stanford-ai-lab', 'Stanford AI Lab Blog', 'https://ai.stanford.edu/blog/feed.xml', 'https://ai.stanford.edu/blog/', { channel: 'research', tier: 1, topics: ['research', 'papers'], pollMinutes: 240 }),
  feed('berkeley-bair', 'Berkeley AI Research Blog', 'https://bair.berkeley.edu/blog/feed.xml', 'https://bair.berkeley.edu/blog/', { channel: 'research', tier: 1, topics: ['research', 'papers'], pollMinutes: 240 }),
  feed('mit-csail', 'MIT CSAIL News', 'https://www.csail.mit.edu/rss.xml', 'https://www.csail.mit.edu/news', { channel: 'research', tier: 1, topics: ['research', 'papers'], pollMinutes: 240 }),
  feed('mit-news-ai', 'MIT News - Artificial Intelligence', 'https://news.mit.edu/rss/topic/artificial-intelligence2', 'https://news.mit.edu/topic/artificial-intelligence2', { channel: 'research', tier: 1, topics: ['research', 'industry'], pollMinutes: 240 }),
  feed('mozilla-ai', 'Mozilla AI Blog', 'https://blog.mozilla.ai/rss/', 'https://blog.mozilla.ai/', { kind: 'first-party', channel: 'blog', tier: 2, topics: ['open-source', 'safety'], pollMinutes: 240 }),
  feed('google-cloud-ai', 'Google Cloud AI & ML Blog', 'https://cloud.google.com/blog/products/ai-machine-learning/rss', 'https://cloud.google.com/blog/products/ai-machine-learning', { kind: 'first-party', channel: 'official', tier: 1, topics: ['cloud', 'enterprise'], pollMinutes: 240 }),
  feed('techcrunch-ai', 'TechCrunch - Artificial Intelligence', 'https://techcrunch.com/category/artificial-intelligence/feed/', 'https://techcrunch.com/category/artificial-intelligence/', { channel: 'media', tier: 2, topics: ['industry', 'funding'], pollMinutes: 120 }),
  feed('venturebeat-ai', 'VentureBeat AI', 'https://venturebeat.com/category/ai/feed/', 'https://venturebeat.com/category/ai/', { channel: 'media', tier: 2, topics: ['industry', 'enterprise'], pollMinutes: 120 }),
  feed('the-decoder', 'The Decoder', 'https://the-decoder.com/feed/', 'https://the-decoder.com/', { channel: 'media', tier: 2, topics: ['models', 'products'], pollMinutes: 120 }),
  feed('mit-tech-review-ai', 'MIT Technology Review - AI', 'https://www.technologyreview.com/topic/artificial-intelligence/feed/', 'https://www.technologyreview.com/topic/artificial-intelligence/', { channel: 'media', tier: 1, topics: ['industry', 'policy'], pollMinutes: 180 }),
  feed('ieee-spectrum-ai', 'IEEE Spectrum - AI', 'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss', 'https://spectrum.ieee.org/artificial-intelligence', { channel: 'media', tier: 1, topics: ['research', 'engineering'], pollMinutes: 180 }),
  feed('ars-technica-ai', 'Ars Technica - AI', 'https://arstechnica.com/ai/feed/', 'https://arstechnica.com/ai/', { channel: 'media', tier: 2, topics: ['industry', 'products'], pollMinutes: 180 }),
  feed('simon-willison', 'Simon Willison', 'https://simonwillison.net/atom/everything/', 'https://simonwillison.net/', { channel: 'blog', tier: 1, topics: ['models', 'engineering', 'agents'], author: 'Simon Willison', pollMinutes: 120 }),
  feed('import-ai', 'Import AI', 'https://jack-clark.net/feed/', 'https://jack-clark.net/', { channel: 'newsletter', tier: 1, topics: ['research', 'policy'], author: 'Jack Clark', pollMinutes: 360 }),
  feed('latent-space', 'Latent Space', 'https://www.latent.space/feed', 'https://www.latent.space/', { channel: 'newsletter', tier: 2, topics: ['agents', 'engineering'], pollMinutes: 240 }),
  feed('the-batch', 'The Batch', 'https://www.deeplearning.ai/the-batch/feed/', 'https://www.deeplearning.ai/the-batch/', { channel: 'newsletter', tier: 1, topics: ['research', 'industry'], author: 'DeepLearning.AI', pollMinutes: 360, enabled: false, forceDisabled: true, disabledReason: '上游已停止提供公开 RSS' }),
  feed('ahead-of-ai', 'Ahead of AI', 'https://magazine.sebastianraschka.com/feed', 'https://magazine.sebastianraschka.com/', { channel: 'newsletter', tier: 1, topics: ['models', 'research'], author: 'Sebastian Raschka', pollMinutes: 360 }),
  feed('lilian-weng', 'Lilian Weng Blog', 'https://lilianweng.github.io/index.xml', 'https://lilianweng.github.io/', { channel: 'blog', tier: 1, topics: ['research', 'agents'], author: 'Lilian Weng', pollMinutes: 360 }),
  feed('chip-huyen', 'Chip Huyen Blog', 'https://huyenchip.com/feed.xml', 'https://huyenchip.com/blog/', { channel: 'blog', tier: 1, topics: ['engineering', 'mlops'], author: 'Chip Huyen', pollMinutes: 360 }),
  feed('eugene-yan', 'Eugene Yan Blog', 'https://eugeneyan.com/rss/', 'https://eugeneyan.com/', { channel: 'blog', tier: 1, topics: ['engineering', 'recommendation'], author: 'Eugene Yan', pollMinutes: 360 }),
  feed('interconnects', 'Interconnects', 'https://www.interconnects.ai/feed', 'https://www.interconnects.ai/', { channel: 'newsletter', tier: 1, topics: ['models', 'research'], author: 'Nathan Lambert', pollMinutes: 360 }),
  feed('one-useful-thing', 'One Useful Thing', 'https://www.oneusefulthing.org/feed', 'https://www.oneusefulthing.org/', { channel: 'newsletter', tier: 2, topics: ['products', 'work'], author: 'Ethan Mollick', pollMinutes: 360 }),
  feed('ai-snake-oil', 'AI Snake Oil', 'https://www.aisnakeoil.com/feed', 'https://www.aisnakeoil.com/', { channel: 'newsletter', tier: 1, topics: ['policy', 'safety'], pollMinutes: 360 }),
  feed('qwen-blog', 'Qwen Blog', 'https://qwenlm.github.io/blog/index.xml', 'https://qwenlm.github.io/blog/', { kind: 'first-party', channel: 'official', tier: 1, topics: ['models', 'open-source'], pollMinutes: 180 })
];

const paperFeeds = ['cs.AI', 'cs.CL', 'cs.LG', 'cs.CV', 'cs.RO', 'cs.IR'].map((category) => feed(
  `arxiv-${category.toLowerCase().replace('.', '-')}`,
  `arXiv ${category}`,
  `https://rss.arxiv.org/rss/${category}`,
  `https://arxiv.org/list/${category}/recent`,
  { channel: 'papers', tier: 1, topics: ['papers', category], pollMinutes: 360, allowArticleFetch: false, allowEmpty: true }
));

const xSources = [
  ['x-openai', 'OpenAI on X', 'OpenAI', ['models', 'products']],
  ['x-anthropic', 'Anthropic on X', 'AnthropicAI', ['models', 'safety']],
  ['x-deepmind', 'Google DeepMind on X', 'GoogleDeepMind', ['research', 'models']],
  ['x-meta-ai', 'Meta AI on X', 'AIatMeta', ['research', 'open-source']],
  ['x-huggingface', 'Hugging Face on X', 'huggingface', ['open-source', 'models']],
  ['x-andrew-ng', 'Andrew Ng on X', 'AndrewYNg', ['education', 'industry']],
  ['x-karpathy', 'Andrej Karpathy on X', 'karpathy', ['models', 'engineering']],
  ['x-yann-lecun', 'Yann LeCun on X', 'ylecun', ['research']],
  ['x-demis-hassabis', 'Demis Hassabis on X', 'demishassabis', ['research', 'models']],
  ['x-hardmaru', 'David Ha on X', 'hardmaru', ['research']],
  ['x-simon-willison', 'Simon Willison on X', 'simonw', ['engineering', 'models']],
  ['x-swyx', 'swyx on X', 'swyx', ['agents', 'engineering']],
  ['x-jeremy-howard', 'Jeremy Howard on X', 'jeremyphoward', ['education', 'open-source']],
  ['x-fei-fei-li', 'Fei-Fei Li on X', 'drfeifei', ['research', 'policy']],
  ['x-jason-wei', 'Jason Wei on X', '_jasonwei', ['research', 'models']]
].map(([id, name, username, topics]) => social(id, name, 'x-user', username, { topics }));

const redditSources = [
  ['reddit-machine-learning', 'Reddit r/MachineLearning', 'MachineLearning', ['research', 'papers']],
  ['reddit-local-llama', 'Reddit r/LocalLLaMA', 'LocalLLaMA', ['local-ai', 'open-source']],
  ['reddit-artificial', 'Reddit r/artificial', 'artificial', ['industry', 'products']],
  ['reddit-singularity', 'Reddit r/singularity', 'singularity', ['industry', 'community']],
  ['reddit-llmdevs', 'Reddit r/LLMDevs', 'LLMDevs', ['engineering', 'models']],
  ['reddit-stablediffusion', 'Reddit r/StableDiffusion', 'StableDiffusion', ['image', 'open-source']],
  ['reddit-comfyui', 'Reddit r/comfyui', 'comfyui', ['image', 'tools']],
  ['reddit-langchain', 'Reddit r/LangChain', 'LangChain', ['agents', 'rag']]
].map(([id, name, subreddit, topics]) => social(id, name, 'reddit-subreddit', subreddit, { topics }));

export const BUILT_IN_SOURCES = Object.freeze([
  ...coreFeeds,
  ...releases,
  ...industryFeeds,
  ...paperFeeds,
  ...xSources,
  ...redditSources
]);

export function mergeBuiltInSources(current = []) {
  const currentById = new Map(current.map((source) => [source.id, source]));
  const merged = BUILT_IN_SOURCES.map((catalogSource) => {
    const saved = currentById.get(catalogSource.id);
    if (!saved) return { ...catalogSource };
    currentById.delete(catalogSource.id);
    return {
      ...saved,
      ...catalogSource,
      enabled: catalogSource.forceDisabled ? false : (saved.enabled ?? catalogSource.enabled),
      pollMinutes: saved.pollMinutes ?? catalogSource.pollMinutes
    };
  });
  return [...merged, ...currentById.values()];
}

export function sourceCatalogSummary(sources = BUILT_IN_SOURCES) {
  const enabled = sources.filter((source) => source.enabled !== false);
  const channels = Object.fromEntries([...new Set(sources.map((source) => source.channel || 'other'))]
    .map((channel) => [channel, sources.filter((source) => (source.channel || 'other') === channel).length]));
  return { total: sources.length, enabled: enabled.length, setupRequired: sources.filter((source) => source.setupRequired).length, channels };
}
