import { createClient } from '@/utils/supabase/server';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import Exa from 'exa-js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const exa = new Exa(process.env.EXA_API_KEY as string);

export async function POST(request: Request) {
  const supabase = createClient();
  const { message, sessionId } = await request.json();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Search content using Exa
    const searchResult = await exa.searchAndContents(message, {
      type: "neural",
      useAutoprompt: true,
      numResults: 10,
      text: {
        includeHtmlTags: false,
        maxCharacters: 300
      },
      summary: true,
      headers: {
        'x-api-key': process.env.EXA_API_KEY as string
      }
    });

    // Generate summaries using OpenAI
    const summariesAndLinks = await Promise.all(searchResult.results.map(async (result: any) => {
      const summaryResponse = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "You are a helpful assistant that summarizes content." },
          { role: "user", content: `Summarize this content in 2-3 sentences: ${result.text}` }
        ],
      });
      return {
        summary: summaryResponse.choices[0].message.content || '',
        link: result.url
      };
    }));

    // Create or get session
    let { data: sessionData, error: sessionError } = await supabase
      .from('research_sessions')
      .select('session_id')
      .eq('session_id', sessionId)
      .single();

    if (sessionError && sessionError.code === 'PGRST116') {
      // Session doesn't exist, create it
      const { data: newSession, error: newSessionError } = await supabase
        .from('research_sessions')
        .insert({ session_id: sessionId, session_name: 'New Research Session' })
        .select('session_id')
        .single();

      if (newSessionError) throw newSessionError;
      sessionData = newSession;
    } else if (sessionError) {
      throw sessionError;
    }

    // Insert query
    const { data: queryData, error: queryError } = await supabase
      .from('queries')
      .insert({ session_id: sessionData!.session_id, query: message })
      .select('id')
      .single();

    if (queryError) throw queryError;

    // Insert search results
    const searchResultsInsert = summariesAndLinks.map(item => ({
      query_id: queryData!.id,
      summary: item.summary,
      source_url: item.link
    }));

    const { error: searchResultsError } = await supabase
      .from('search_results')
      .insert(searchResultsInsert);

    if (searchResultsError) throw searchResultsError;

    // Generate an overall summary using OpenAI
    const summariesText = summariesAndLinks.map(item => item.summary).join('\n');
    const finalResponse = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a helpful research assistant. Summarize the findings and provide insights." },
        { role: "user", content: `Based on these summaries, provide a concise overall summary of the research topic: ${message}\n\nSummaries:\n${summariesText}` }
      ],
    });

    // Insert AI response
    const { error: aiResponseError } = await supabase
      .from('ai_responses')
      .insert({
        query_id: queryData!.id,
        response: finalResponse.choices[0].message.content
      });

    if (aiResponseError) throw aiResponseError;

    return NextResponse.json({ 
      message: finalResponse.choices[0].message.content,
      summariesAndLinks: summariesAndLinks
    });

  } catch (error) {
    console.error('Error in enhanced chat API:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}