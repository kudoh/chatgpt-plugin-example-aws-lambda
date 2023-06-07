import { APIGatewayEvent, APIGatewayProxyHandler, Context } from 'aws-lambda';
import { Octokit } from 'octokit';

const CORSHeaders = {
  'Access-Control-Allow-Origin': 'https://chat.openai.com',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Allow-Headers': '*'
};

type Repo = {
  full_name: string,
  url: string,
  star: number,
  description: string
}

const octokit = new Octokit({
  // ユーザーアクセストークンを使用するため不要
  // auth: process.env.GITHUB_TOKEN
});
export const search: APIGatewayProxyHandler = async (event: APIGatewayEvent, context: Context) => {
  const { q } = event.queryStringParameters ?? {};
  const resp = await octokit.request('GET /search/repositories', {
    q,
    sort: 'stars',
    order: 'desc',
    per_page: 5,
    // ChatGPTが取得するGitHubアクセストークン(Bearer ghu_xxxxxxx)をそのまま指定
    headers: {
      authorization: event.headers.Authorization
    }
  });
  const repos: Repo[] = resp.data.items.map(item => ({
    full_name: item.full_name,
    url: item.url,
    star: item.stargazers_count,
    description: item.description
  }));
  console.log('fetched', repos);
  return {
    statusCode: 200,
    body: JSON.stringify({
      repos
    }),
    headers: {
      ...CORSHeaders,
      'Content-Type': 'application/json'
    }
  };
};
